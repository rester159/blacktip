// BlackTip TLS side-channel daemon.
//
// Reads newline-delimited JSON requests from stdin, performs HTTP
// requests with a real Chrome TLS fingerprint via bogdanfinn/tls-client,
// and writes newline-delimited JSON responses to stdout.
//
// This is the v0.3.0 answer to the question: "what do I do when an edge
// gates the very first request before BlackTip's browser has a session?"
// You use this daemon to make the gating request — it presents a real
// Chrome TLS ClientHello, real H2 frames, and real headers — capture
// the cookies and tokens it gets back, and inject them into the
// browser session before the user-driven flow continues.
//
// Wire format:
//
//   Request:  {"id":"<string>","url":"<string>","method":"<GET|POST|...>","headers":{"...":"..."},"body":"<string base64>","timeoutMs":15000,"profile":"chrome_133"}
//   Response: {"id":"<string>","ok":true,"status":200,"headers":{"...":["...","..."]},"body":"<string base64>","finalUrl":"<string>","durationMs":123}
//             OR
//             {"id":"<string>","ok":false,"error":"<message>","durationMs":123}
//
// One JSON object per line in both directions. The Node parent reads
// stdout line-by-line and matches responses by id. The daemon stays
// alive across many requests so we don't pay subprocess startup cost
// per call.
package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	http "github.com/bogdanfinn/fhttp"
	tls_client "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
)

type request struct {
	ID        string            `json:"id"`
	URL       string            `json:"url"`
	Method    string            `json:"method"`
	Headers   map[string]string `json:"headers"`
	Body      string            `json:"body"`
	TimeoutMs int               `json:"timeoutMs"`
	Profile   string            `json:"profile"`
}

type response struct {
	ID         string              `json:"id"`
	OK         bool                `json:"ok"`
	Status     int                 `json:"status,omitempty"`
	Headers    map[string][]string `json:"headers,omitempty"`
	Body       string              `json:"body,omitempty"`
	FinalURL   string              `json:"finalUrl,omitempty"`
	DurationMs int64               `json:"durationMs"`
	Error      string              `json:"error,omitempty"`
}

// resolveProfile maps a profile name to a tls-client ClientProfile.
// Defaults to the latest Chrome at the time of writing.
func resolveProfile(name string) profiles.ClientProfile {
	switch strings.ToLower(name) {
	case "chrome_120":
		return profiles.Chrome_120
	case "chrome_124":
		return profiles.Chrome_124
	case "chrome_131":
		return profiles.Chrome_131
	case "chrome_133":
		return profiles.Chrome_133
	case "firefox_120":
		return profiles.Firefox_120
	case "safari_ios_16_0":
		return profiles.Safari_IOS_16_0
	default:
		return profiles.Chrome_133
	}
}

// buildClient constructs a tls-client with the requested profile and timeout.
// We rebuild on every request because timeout is per-request and the cost
// is negligible compared to the network round-trip.
func buildClient(profile profiles.ClientProfile, timeoutMs int) (tls_client.HttpClient, error) {
	if timeoutMs <= 0 {
		timeoutMs = 15000
	}
	options := []tls_client.HttpClientOption{
		tls_client.WithTimeoutSeconds(timeoutMs / 1000),
		tls_client.WithClientProfile(profile),
		tls_client.WithNotFollowRedirects(),
	}
	return tls_client.NewHttpClient(tls_client.NewNoopLogger(), options...)
}

func handle(req request) response {
	start := time.Now()
	durationFor := func() int64 { return time.Since(start).Milliseconds() }

	if req.URL == "" {
		return response{ID: req.ID, OK: false, Error: "url is required", DurationMs: durationFor()}
	}
	method := req.Method
	if method == "" {
		method = "GET"
	}

	client, err := buildClient(resolveProfile(req.Profile), req.TimeoutMs)
	if err != nil {
		return response{ID: req.ID, OK: false, Error: "buildClient: " + err.Error(), DurationMs: durationFor()}
	}

	var bodyReader io.Reader
	if req.Body != "" {
		decoded, decErr := base64.StdEncoding.DecodeString(req.Body)
		if decErr != nil {
			return response{ID: req.ID, OK: false, Error: "body base64 decode: " + decErr.Error(), DurationMs: durationFor()}
		}
		bodyReader = strings.NewReader(string(decoded))
	}

	httpReq, err := http.NewRequest(method, req.URL, bodyReader)
	if err != nil {
		return response{ID: req.ID, OK: false, Error: "NewRequest: " + err.Error(), DurationMs: durationFor()}
	}

	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}
	// If the caller didn't set Accept-Language, fall back to a Chrome default.
	if httpReq.Header.Get("Accept-Language") == "" {
		httpReq.Header.Set("Accept-Language", "en-US,en;q=0.9")
	}

	resp, err := client.Do(httpReq)
	if err != nil {
		return response{ID: req.ID, OK: false, Error: "Do: " + err.Error(), DurationMs: durationFor()}
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return response{ID: req.ID, OK: false, Error: "read body: " + err.Error(), DurationMs: durationFor()}
	}

	headers := make(map[string][]string, len(resp.Header))
	for k, v := range resp.Header {
		headers[k] = v
	}

	finalURL := req.URL
	if resp.Request != nil && resp.Request.URL != nil {
		finalURL = resp.Request.URL.String()
	}

	return response{
		ID:         req.ID,
		OK:         true,
		Status:     resp.StatusCode,
		Headers:    headers,
		Body:       base64.StdEncoding.EncodeToString(bodyBytes),
		FinalURL:   finalURL,
		DurationMs: durationFor(),
	}
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	// Allow large request bodies (e.g. POSTed forms with file fields).
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)

	// Stdout writes are mutex-protected so concurrent handlers don't
	// interleave their JSON lines.
	var stdoutMu sync.Mutex
	emit := func(r response) {
		out, err := json.Marshal(r)
		if err != nil {
			out = []byte(fmt.Sprintf(`{"id":%q,"ok":false,"error":"marshal failed: %s"}`, r.ID, err.Error()))
		}
		stdoutMu.Lock()
		defer stdoutMu.Unlock()
		os.Stdout.Write(out)
		os.Stdout.Write([]byte("\n"))
	}

	var wg sync.WaitGroup
	for scanner.Scan() {
		line := append([]byte(nil), scanner.Bytes()...)
		if len(line) == 0 {
			continue
		}
		var req request
		if err := json.Unmarshal(line, &req); err != nil {
			emit(response{ID: "", OK: false, Error: "unmarshal: " + err.Error()})
			continue
		}
		// Handle requests concurrently — the Go TLS client is goroutine-safe.
		wg.Add(1)
		go func(r request) {
			defer wg.Done()
			emit(handle(r))
		}(req)
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintln(os.Stderr, "scan error:", err)
		os.Exit(1)
	}
	// Wait for any in-flight requests to drain before exiting. Without
	// this, closing stdin races the goroutines and the parent never
	// sees the response.
	wg.Wait()
}
