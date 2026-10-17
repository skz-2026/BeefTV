package providerpreset

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// Image contracts describe gateway wire formats that differ from Images edits.
//
//go:embed image_contracts.json
var imageContractJSON []byte

type ImageContract struct {
	Model          string            `json:"model"`
	Protocol       string            `json:"protocol"`
	Path           string            `json:"path"`
	PromptMaxChars int               `json:"promptMaxChars"`
	MaxImages      int               `json:"maxImages"`
	MaxImageBytes  int64             `json:"maxImageBytes"`
	MinSide        int               `json:"minSide"`
	MaxSide        int               `json:"maxSide"`
	MaxPixels      int               `json:"maxPixels"`
	Sizes          map[string]string `json:"sizes"`
}

var imageContracts = func() []ImageContract {
	var contracts []ImageContract
	if err := json.Unmarshal(imageContractJSON, &contracts); err != nil {
		panic(err)
	}
	return contracts
}()

func BeefAPIImageContract(model string) (ImageContract, bool) {
	for _, contract := range imageContracts {
		if strings.EqualFold(strings.TrimSpace(model), contract.Model) {
			return contract, true
		}
	}
	return ImageContract{}, false
}

func (c ImageContract) PixelSize(size string) (string, error) {
	size = strings.ToLower(strings.TrimSpace(strings.ReplaceAll(size, "×", "x")))
	if size == "" || size == "auto" {
		size = "1:1"
	}
	if pixels, ok := c.Sizes[size]; ok {
		size = pixels
	}
	parts := strings.Split(size, "x")
	if len(parts) != 2 {
		return "", fmt.Errorf("当前图片模型不支持尺寸 %s", size)
	}
	w, errW := strconv.Atoi(parts[0])
	h, errH := strconv.Atoi(parts[1])
	if errW != nil || errH != nil || w < c.MinSide || h < c.MinSide || w > c.MaxSide || h > c.MaxSide || int64(w)*int64(h) > int64(c.MaxPixels) {
		return "", fmt.Errorf("当前图片模型宽高须在 %d～%d 之间，总像素不能超过 %d", c.MinSide, c.MaxSide, c.MaxPixels)
	}
	return fmt.Sprintf("%dx%d", w, h), nil
}
