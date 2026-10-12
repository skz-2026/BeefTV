package generation

import (
	"errors"
	"net/http"
	"strings"
)

// ErrImageOwnerMissing is returned when a recoverable BeefAPI image POST has
// no Images port or the port declined to take ownership. Callers must not
// open a new upstream request.
var ErrImageOwnerMissing = errors.New("图片请求缺少恢复所有者")

// RecoverableImageEndpoint reports whether req is a paid BeefAPI image create
// that must run through ImageSubmissionPort. Other hosts stay on the normal
// POST path.
func RecoverableImageEndpoint(req *http.Request) bool {
	if req == nil || req.URL == nil || req.Method != http.MethodPost || req.URL.Scheme != "https" || req.URL.User != nil || req.URL.RawQuery != "" || (req.URL.Port() != "" && req.URL.Port() != "443") {
		return false
	}
	return PaidImageHost(req.URL.Hostname()) && (req.URL.Path == "/v1/images/generations" || req.URL.Path == "/v1/images/edits")
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
