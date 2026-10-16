package promptlibrary

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
)

// 官方数据集 schema（scripts/prompt_library.py 同源）：
//
//	prompts(tweet_id, author, tool, prompt_text, created_at, tweet_url, collected_at)
//	images(tweet_id, image_index, url, local_path)
//	prompt_translations(tweet_id, locale, translated_text, translation_version)
//	prompt_labels / media_labels(tweet_id, label_id, taxonomy_version, confidence[, media_type])
//	taxonomy_labels(taxonomy_version, label_id, dimension_key, key, display_en, display_zh)
//
// 检索与官方 CLI 一样不依赖 FTS5：LIKE + 标签索引即可覆盖 2 万行的量级。
const (
	localeZhHans    = "zh-Hans"
	candidateLimit  = 2000
	listTagsPerItem = 8
)

type datasetCounts struct {
	prompts      int64
	images       int64
	translations int64
}

func (s *Service) reader() (*sql.DB, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.db == nil {
		return nil, ErrNotInstalled
	}
	return s.db, nil
}

func (s *Service) counts(ctx context.Context) (datasetCounts, error) {
	db, err := s.reader()
	if err != nil {
		return datasetCounts{}, err
	}
	var counts datasetCounts
	err = db.QueryRowContext(ctx, `SELECT
		(SELECT COUNT(*) FROM prompts),
		(SELECT COUNT(*) FROM images),
		(SELECT COUNT(*) FROM prompt_translations)`).Scan(&counts.prompts, &counts.images, &counts.translations)
	return counts, err
}

// activeTaxonomyVersion 优先读 archive_config 的 active_taxonomy_version，
// 缺失时回退到标签表中的众数版本；随连接切换缓存。
func (s *Service) activeTaxonomyVersion(ctx context.Context) (string, error) {
	s.mu.RLock()
	db, version := s.db, s.taxonomyVersion
	s.mu.RUnlock()
	if db == nil {
		return "", ErrNotInstalled
	}
	if version != "" {
		return version, nil
	}
	var resolved string
	err := db.QueryRowContext(ctx, `SELECT value FROM archive_config WHERE key = 'active_taxonomy_version' LIMIT 1`).Scan(&resolved)
	if err != nil || strings.TrimSpace(resolved) == "" {
		err = db.QueryRowContext(ctx, `SELECT taxonomy_version FROM taxonomy_labels
			GROUP BY taxonomy_version ORDER BY COUNT(*) DESC LIMIT 1`).Scan(&resolved)
	}
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	s.taxonomyVersion = resolved
	s.mu.Unlock()
	return resolved, nil
}

// Labels 返回标签筛选面板的全量双语标签。
func (s *Service) Labels(ctx context.Context) ([]LabelInfo, error) {
	db, err := s.reader()
	if err != nil {
		return nil, err
	}
	version, err := s.activeTaxonomyVersion(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx, `SELECT dimension_key, key, display_en, display_zh
		FROM taxonomy_labels WHERE taxonomy_version = ? ORDER BY dimension_key, key`, version)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	labels := make([]LabelInfo, 0, 256)
	for rows.Next() {
		var label LabelInfo
		if err := rows.Scan(&label.Dimension, &label.Key, &label.DisplayEn, &label.DisplayZh); err != nil {
			return nil, err
		}
		labels = append(labels, label)
	}
	return labels, rows.Err()
}

type scoredCandidate struct {
	item PromptSummary
	rank int
}

// Search 检索提示词：文本词（prompt/中译/作者/工具，AND 语义）+ 标签交集过滤，
// 候选集截断到 candidateLimit 后在进程内打分排序分页。
func (s *Service) Search(ctx context.Context, params SearchParams) (SearchPage, error) {
	db, err := s.reader()
	if err != nil {
		return SearchPage{}, err
	}
	if params.Page < 1 {
		params.Page = 1
	}
	if params.PageSize < 1 || params.PageSize > 60 {
		params.PageSize = 24
	}
	terms := splitTerms(params.Query)
	where := make([]string, 0, 4)
	args := make([]any, 0, 16)
	if tool := strings.TrimSpace(params.Tool); tool != "" {
		where = append(where, "p.tool = ?")
		args = append(args, tool)
	}
	if author := strings.TrimSpace(params.Author); author != "" {
		where = append(where, `p.author LIKE ? ESCAPE '\'`)
		args = append(args, "%"+escapeLike(author)+"%")
	}
	for _, term := range terms {
		pattern := "%" + escapeLike(term) + "%"
		where = append(where, `(p.prompt_text LIKE ? ESCAPE '\' OR p.author LIKE ? ESCAPE '\' OR p.tool LIKE ? ESCAPE '\' OR EXISTS (
			SELECT 1 FROM prompt_translations tr WHERE tr.tweet_id = p.tweet_id AND tr.translated_text LIKE ? ESCAPE '\'))`)
		args = append(args, pattern, pattern, pattern, pattern)
	}
	version, err := s.activeTaxonomyVersion(ctx)
	if err != nil {
		return SearchPage{}, err
	}
	labelIDs := make([]int64, 0, len(params.Tags))
	for _, tag := range params.Tags {
		dimension, key, found := strings.Cut(strings.TrimSpace(tag), ":")
		if !found || dimension == "" || key == "" {
			continue
		}
		var labelID int64
		err := db.QueryRowContext(ctx, `SELECT label_id FROM taxonomy_labels
			WHERE taxonomy_version = ? AND dimension_key = ? AND key = ? LIMIT 1`, version, dimension, key).Scan(&labelID)
		if err != nil {
			if err == sql.ErrNoRows {
				return SearchPage{Items: []PromptSummary{}, Page: params.Page, PageSize: params.PageSize}, nil
			}
			return SearchPage{}, err
		}
		labelIDs = append(labelIDs, labelID)
		where = append(where, `EXISTS (
			SELECT 1 FROM prompt_labels pl WHERE pl.tweet_id = p.tweet_id AND pl.label_id = ? AND pl.taxonomy_version = ?
			UNION ALL
			SELECT 1 FROM media_labels ml WHERE ml.tweet_id = p.tweet_id AND ml.label_id = ? AND ml.taxonomy_version = ?)`)
		args = append(args, labelID, version, labelID, version)
	}
	clause := ""
	if len(where) > 0 {
		clause = "WHERE " + strings.Join(where, " AND ")
	}
	query := fmt.Sprintf(`SELECT p.tweet_id, p.author, p.tool, p.prompt_text, p.created_at, p.tweet_url,
		(SELECT tr.translated_text FROM prompt_translations tr WHERE tr.tweet_id = p.tweet_id AND tr.locale = ? LIMIT 1) AS translation_zh,
		EXISTS(SELECT 1 FROM images i WHERE i.tweet_id = p.tweet_id) AS has_image
		FROM prompts p %s
		ORDER BY CAST(p.tweet_id AS INTEGER) DESC
		LIMIT %d`, clause, candidateLimit)
	rows, err := db.QueryContext(ctx, query, append([]any{localeZhHans}, args...)...)
	if err != nil {
		return SearchPage{}, err
	}
	defer rows.Close()
	candidates := make([]scoredCandidate, 0, 128)
	for rows.Next() {
		var candidate scoredCandidate
		var hasImage bool
		// 真实数据里 author/tool/created_at/tweet_url 都可能为 NULL。
		var author, tool, promptText, createdAt, tweetURL, translation sql.NullString
		if err := rows.Scan(&candidate.item.TweetID, &author, &tool, &promptText, &createdAt, &tweetURL, &translation, &hasImage); err != nil {
			return SearchPage{}, err
		}
		candidate.item.Author = author.String
		candidate.item.Tool = tool.String
		candidate.item.PromptText = promptText.String
		candidate.item.CreatedAt = createdAt.String
		candidate.item.TweetURL = tweetURL.String
		candidate.item.TranslationZh = translation.String
		candidate.rank = scoreCandidate(candidate.item, terms, hasImage)
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		return SearchPage{}, err
	}
	if len(terms) > 0 {
		sort.SliceStable(candidates, func(i, j int) bool {
			if candidates[i].rank != candidates[j].rank {
				return candidates[i].rank > candidates[j].rank
			}
			return compareTweetIDDesc(candidates[i].item.TweetID, candidates[j].item.TweetID)
		})
	}
	total := len(candidates)
	start := (params.Page - 1) * params.PageSize
	if start >= total {
		return SearchPage{Items: []PromptSummary{}, Page: params.Page, PageSize: params.PageSize, Total: total, HasMore: false}, nil
	}
	end := start + params.PageSize
	if end > total {
		end = total
	}
	page := candidates[start:end]
	items := make([]PromptSummary, len(page))
	for index := range page {
		items[index] = page[index].item
	}
	if err := s.hydrateItems(ctx, db, version, items, listTagsPerItem); err != nil {
		return SearchPage{}, err
	}
	return SearchPage{Items: items, Page: params.Page, PageSize: params.PageSize, Total: total, HasMore: end < total}, nil
}

// Detail 返回单条提示词的全量信息（全部图片、全部标签、可选配方）。
func (s *Service) Detail(ctx context.Context, tweetID string) (*PromptSummary, error) {
	db, err := s.reader()
	if err != nil {
		return nil, err
	}
	var item PromptSummary
	var author, tool, promptText, createdAt, tweetURL, translation sql.NullString
	err = db.QueryRowContext(ctx, `SELECT p.tweet_id, p.author, p.tool, p.prompt_text, p.created_at, p.tweet_url,
		(SELECT tr.translated_text FROM prompt_translations tr WHERE tr.tweet_id = p.tweet_id AND tr.locale = ? LIMIT 1)
		FROM prompts p WHERE p.tweet_id = ? LIMIT 1`, localeZhHans, tweetID).
		Scan(&item.TweetID, &author, &tool, &promptText, &createdAt, &tweetURL, &translation)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, ErrNotFound
		}
		return nil, err
	}
	item.Author, item.Tool = author.String, tool.String
	item.PromptText, item.CreatedAt, item.TweetURL = promptText.String, createdAt.String, tweetURL.String
	item.TranslationZh = translation.String
	items := []PromptSummary{item}
	if err := s.hydrateItems(ctx, db, "", items, 0); err != nil {
		return nil, err
	}
	result := &items[0]
	if s.hasTable(ctx, "prompt_recipes") {
		var recipeEn, recipeZh sql.NullString
		_ = db.QueryRowContext(ctx, `SELECT recipe_text_en, recipe_text_zh FROM prompt_recipes
			WHERE tweet_id = ? LIMIT 1`, tweetID).Scan(&recipeEn, &recipeZh)
		result.RecipeEn, result.RecipeZh = recipeEn.String, recipeZh.String
	}
	return result, nil
}

// ImageFile 解析图片的本地图片包文件路径；包未下载时返回 ErrPackMissing。
func (s *Service) ImageFile(ctx context.Context, tweetID string, index int) (string, error) {
	db, err := s.reader()
	if err != nil {
		return "", err
	}
	var localPath sql.NullString
	err = db.QueryRowContext(ctx, `SELECT local_path FROM images WHERE tweet_id = ? AND image_index = ? LIMIT 1`,
		tweetID, index).Scan(&localPath)
	if err != nil {
		if err == sql.ErrNoRows {
			return "", ErrNotFound
		}
		return "", err
	}
	relative := strings.TrimSpace(strings.TrimPrefix(strings.ReplaceAll(localPath.String, "\\", "/"), "/"))
	if relative == "" {
		return "", ErrPackMissing
	}
	absolute := filepath.Join(s.dataRoot, filepath.FromSlash(relative))
	cleanedRoot := filepath.Clean(s.dataRoot)
	if !strings.HasPrefix(filepath.Clean(absolute)+string(filepath.Separator), cleanedRoot+string(filepath.Separator)) {
		return "", ErrPackMissing
	}
	if !fileExists(absolute) {
		return "", ErrPackMissing
	}
	return absolute, nil
}

// hydrateItems 批量填充图片与标签；tagLimit <= 0 表示不截断（详情模式）。
func (s *Service) hydrateItems(ctx context.Context, db *sql.DB, taxonomyVersion string, items []PromptSummary, tagLimit int) error {
	if len(items) == 0 {
		return nil
	}
	ids := make([]any, len(items))
	placeholders := make([]string, len(items))
	indexOf := make(map[string]int, len(items))
	for i, item := range items {
		ids[i] = item.TweetID
		placeholders[i] = "?"
		indexOf[item.TweetID] = i
	}
	idList := strings.Join(placeholders, ",")
	rows, err := db.QueryContext(ctx, fmt.Sprintf(
		`SELECT tweet_id, image_index, url, local_path FROM images WHERE tweet_id IN (%s) ORDER BY tweet_id, image_index`, idList), ids...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var tweetID string
		var image ImageInfo
		var url sql.NullString
		var localPath sql.NullString
		if err := rows.Scan(&tweetID, &image.Index, &url, &localPath); err != nil {
			return err
		}
		if target, ok := indexOf[tweetID]; ok {
			image.TweetID = tweetID
			image.URL = url.String
			image.LocalPath = localPath.String
			image.LocalReady = localPath.String != "" && fileExists(filepath.Join(s.dataRoot, filepath.FromSlash(strings.TrimPrefix(strings.ReplaceAll(localPath.String, "\\", "/"), "/"))))
			items[target].Images = append(items[target].Images, image)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for i := range items {
		items[i].ImageCount = len(items[i].Images)
		if items[i].Images == nil {
			items[i].Images = []ImageInfo{}
		}
	}
	// 标签：prompt_labels 与 media_labels 并集，按置信度排序去重。
	tagRows, err := s.queryLabels(ctx, db, taxonomyVersion, idList, ids)
	if err != nil {
		return err
	}
	defer tagRows.Close()
	for tagRows.Next() {
		var tweetID string
		var tag TagInfo
		if err := tagRows.Scan(&tweetID, &tag.Dimension, &tag.Key, &tag.DisplayEn, &tag.DisplayZh, &tag.Confidence); err != nil {
			return err
		}
		if target, ok := indexOf[tweetID]; ok {
			items[target].Tags = append(items[target].Tags, tag)
		}
	}
	if err := tagRows.Err(); err != nil {
		return err
	}
	for i := range items {
		items[i].Tags = dedupeTags(items[i].Tags, tagLimit)
	}
	return nil
}

func (s *Service) queryLabels(ctx context.Context, db *sql.DB, taxonomyVersion, idList string, ids []any) (*sql.Rows, error) {
	args := make([]any, 0, len(ids)*2+2)
	versionFilter := ""
	if taxonomyVersion != "" {
		versionFilter = "AND tl.taxonomy_version = ?"
	}
	args = append(args, ids...)
	if taxonomyVersion != "" {
		args = append(args, taxonomyVersion)
	}
	args = append(args, ids...)
	if taxonomyVersion != "" {
		args = append(args, taxonomyVersion)
	}
	return db.QueryContext(ctx, fmt.Sprintf(`SELECT pl.tweet_id, tl.dimension_key, tl.key, tl.display_en, tl.display_zh, pl.confidence
		FROM prompt_labels pl JOIN taxonomy_labels tl ON tl.label_id = pl.label_id AND tl.taxonomy_version = pl.taxonomy_version
		WHERE pl.tweet_id IN (%s) %s
		UNION ALL
		SELECT ml.tweet_id, tl.dimension_key, tl.key, tl.display_en, tl.display_zh, ml.confidence
		FROM media_labels ml JOIN taxonomy_labels tl ON tl.label_id = ml.label_id AND tl.taxonomy_version = ml.taxonomy_version
		WHERE ml.tweet_id IN (%s) %s AND ml.media_type = 'image'`, idList, versionFilter, idList, versionFilter), args...)
}

func (s *Service) hasTable(ctx context.Context, name string) bool {
	db, err := s.reader()
	if err != nil {
		return false
	}
	var count int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`, name).Scan(&count); err != nil {
		return false
	}
	return count > 0
}

func dedupeTags(tags []TagInfo, limit int) []TagInfo {
	sort.SliceStable(tags, func(i, j int) bool {
		if tags[i].Confidence != tags[j].Confidence {
			return tags[i].Confidence > tags[j].Confidence
		}
		return tags[i].Dimension+":"+tags[i].Key < tags[j].Dimension+":"+tags[j].Key
	})
	result := make([]TagInfo, 0, len(tags))
	seen := map[string]bool{}
	for _, tag := range tags {
		id := tag.Dimension + ":" + tag.Key
		if seen[id] {
			continue
		}
		seen[id] = true
		result = append(result, tag)
		if limit > 0 && len(result) >= limit {
			break
		}
	}
	if result == nil {
		result = []TagInfo{}
	}
	return result
}

func splitTerms(query string) []string {
	fields := strings.FieldsFunc(strings.TrimSpace(query), func(r rune) bool {
		return r == ' ' || r == '\t' || r == '\n' || r == ',' || r == '，' || r == '、' || r == ';' || r == '；'
	})
	terms := make([]string, 0, len(fields))
	for _, field := range fields {
		if trimmed := strings.TrimSpace(field); trimmed != "" {
			terms = append(terms, trimmed)
		}
	}
	if len(terms) > 8 {
		terms = terms[:8]
	}
	return terms
}

func escapeLike(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return replacer.Replace(value)
}

func scoreCandidate(item PromptSummary, terms []string, hasImage bool) int {
	score := 0
	if hasImage {
		score++
	}
	lowerPrompt := strings.ToLower(item.PromptText)
	lowerZh := strings.ToLower(item.TranslationZh)
	lowerAuthor := strings.ToLower(item.Author)
	lowerTool := strings.ToLower(item.Tool)
	for _, term := range terms {
		needle := strings.ToLower(term)
		switch {
		case strings.Contains(lowerPrompt, needle):
			score += 3
		case strings.Contains(lowerZh, needle):
			score += 2
		case strings.Contains(lowerAuthor, needle) || strings.Contains(lowerTool, needle):
			score += 1
		}
	}
	return score
}

func compareTweetIDDesc(a, b string) bool {
	if len(a) != len(b) {
		return len(a) > len(b)
	}
	return a > b
}
