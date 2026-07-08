// Mayfly in-VM launcher (spike).
// Models the agent that will live inside the MicroVM: it listens on an HTTP
// endpoint, receives a JIT runner config from the control plane, runs the
// GitHub Actions runner for exactly one job, then exits with the runner's code.
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/exec"
)

type runReq struct {
	JitConfig string `json:"jitconfig"`
}

func main() {
	done := make(chan int, 1)

	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})

	http.HandleFunc("/run", func(w http.ResponseWriter, r *http.Request) {
		var req runReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.JitConfig == "" {
			http.Error(w, `bad request: need {"jitconfig":"<base64>"}`, http.StatusBadRequest)
			return
		}
		log.Println("[launcher] received JIT config; starting runner for one job")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte("accepted\n"))

		go func() {
			cmd := exec.Command("/actions-runner/run.sh", "--jitconfig", req.JitConfig)
			cmd.Dir = "/actions-runner"
			cmd.Stdout = os.Stdout
			cmd.Stderr = os.Stderr
			code := 0
			if err := cmd.Run(); err != nil {
				if ee, ok := err.(*exec.ExitError); ok {
					code = ee.ExitCode()
				} else {
					code = 1
				}
			}
			log.Printf("[launcher] runner process exited code=%d", code)
			done <- code
		}()
	})

	go func() {
		log.Println("[launcher] listening on :8080, waiting for JIT config…")
		if err := http.ListenAndServe(":8080", nil); err != nil {
			log.Fatal(err)
		}
	}()

	code := <-done
	log.Printf("[launcher] one job complete; exiting code=%d", code)
	os.Exit(code)
}
