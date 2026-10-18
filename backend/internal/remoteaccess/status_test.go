package remoteaccess

import "testing"

func TestParseStatusReadsDNSNameAndMagicDNS(t *testing.T) {
	raw := []byte(`{"Self":{"DNSName":"wds-mccc.tail4347f3.ts.net."},"CurrentTailnet":{"MagicDNSEnabled":true}}`)
	dns, magic, err := parseStatus(raw)
	if err != nil {
		t.Fatalf("parseStatus: %v", err)
	}
	if dns != "wds-mccc.tail4347f3.ts.net" {
		t.Fatalf("dns = %q", dns)
	}
	if !magic {
		t.Fatal("magic dns must be reported")
	}
}

func TestParseStatusRejectsBrokenJSON(t *testing.T) {
	if _, _, err := parseStatus([]byte(`not json`)); err == nil {
		t.Fatal("broken JSON must fail")
	}
}

func TestParseStatusReportsLoggedOut(t *testing.T) {
	dns, _, err := parseStatus([]byte(`{"Self":{},"CurrentTailnet":{}}`))
	if err != nil || dns != "" {
		t.Fatalf("dns = %q, err = %v", dns, err)
	}
}

func TestParseServePortFindsNonDefaultPort(t *testing.T) {
	raw := []byte(`{"TCP":{"443":{"HTTPS":true},"8443":{"HTTPS":true}},"Web":{
		"wds-mccc.tail4347f3.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3773"}}},
		"wds-mccc.tail4347f3.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000/"}}}}}`)
	port, ok := parseServePort(raw)
	if !ok || port != 8443 {
		t.Fatalf("port = %d, ok = %v", port, ok)
	}
}

func TestParseServePortIgnoresOtherServices(t *testing.T) {
	raw := []byte(`{"Web":{"wds-mccc.tail4347f3.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3773"}}}}}`)
	if port, ok := parseServePort(raw); ok || port != 0 {
		t.Fatalf("port = %d, ok = %v", port, ok)
	}
}
