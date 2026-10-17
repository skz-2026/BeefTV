package generation

import (
	"context"
	"errors"
	"infinite-canvas/backend/internal/outbound"
	"net/http"
	"strings"
	"time"
)

// ErrImageOwnerMissing is returned when a recoverable BeefAPI image POST has
// no Images port or the port declined to take ownership. Callers must not
// open a new upstream request.
var ErrImageOwnerMissing = errors.New("图片请求缺少恢复所有者")

const ImageReplayProtocol = "idempotency-key-v1"

type imageReplayProtocolContext struct{}

func WithImageReplayProtocol(ctx context.Context, protocol string) context.Context {
	return context.WithValue(ctx, imageReplayProtocolContext{}, protocol)
}

func imageSubmissionURL(req *http.Request) bool {
	return req != nil && req.URL != nil && req.Method == http.MethodPost && req.URL.Scheme == "https" && req.URL.Hostname() != "" && req.URL.User == nil && req.URL.RawQuery == "" && req.URL.Fragment == "" && (strings.HasSuffix(req.URL.Path, "/images/generations") || strings.HasSuffix(req.URL.Path, "/images/edits"))
}

// The endpoint advertises its replay contract; a hostname never grants it.
// Probe only metadata on the same origin and never forward credentials across
// a redirect. Unsupported endpoints keep their existing single-POST path.
func NegotiateImageReplay(req *http.Request) (*http.Request, error) {
	return negotiateImageReplay(req, outbound.OutboundHTTPClient(5*time.Second))
}

func negotiateImageReplay(req *http.Request, configured *http.Client) (*http.Request, error) {
	if !imageSubmissionURL(req) || RecoverableImageEndpoint(req) {
		return req, nil
	}
	if err := req.Context().Err(); err != nil {
		return nil, err
	}
	u := *req.URL
	if strings.HasSuffix(u.Path, "/images/generations") {
		u.Path = strings.TrimSuffix(u.Path, "/images/generations") + "/models"
	} else {
		u.Path = strings.TrimSuffix(u.Path, "/images/edits") + "/models"
	}
	u.RawPath = ""
	if _, err := outbound.ValidateOutboundURL(u.String()); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(req.Context(), 5*time.Second)
	defer cancel()
	probe, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	probe.Header = req.Header.Clone()
	for _, name := range []string{"Content-Type", "Content-Length", "Transfer-Encoding", "Idempotency-Key", "X-Idempotency-Key"} {
		probe.Header.Del(name)
	}
	outbound.ApplyDefaultOutboundHeaders(probe)
	client := *configured
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(probe)
	if err != nil {
		if req.Context().Err() != nil {
			return nil, req.Context().Err()
		}
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 && resp.Header.Get("X-Image-Submission-Protocol") == ImageReplayProtocol {
		return req.WithContext(WithImageReplayProtocol(req.Context(), ImageReplayProtocol)), nil
	}
	return req, nil
}

// RecoverableImageEndpoint requires an advertised protocol and a matching
// image submission URL. Unsupported providers stay on the single-POST path.
func RecoverableImageEndpoint(req *http.Request) bool {
	if !imageSubmissionURL(req) {
		return false
	}
	protocol, _ := req.Context().Value(imageReplayProtocolContext{}).(string)
	return protocol == ImageReplayProtocol
}

// PaidImageHost reports whether hostname is a paid BeefAPI origin whose image
// generations are billed and therefore must never be blindly re-dispatched
// after an uncertain outcome. Local/self-hosted gateways are free and may be.
func PaidImageHost(hostname string) bool {
	switch strings.ToLower(hostname) {
	case "beeftv.app", "beefapi.com", "enterprise.beefapi.com", "global.beefapi.com":
		return true
	default:
		return false
	}
}
