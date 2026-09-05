package main

import "errors"

// Dispatch is validated before configuration, identity creation or output cleanup.
func commandMode(args []string) (string, error) {
	if len(args) == 0 {
		return "run", nil
	}
	if len(args) == 1 {
		switch args[0] {
		case "version", "enroll", "operator-manifest", "preflight":
			return args[0], nil
		}
	}
	return "", errors.New("usage: native-broadcast-packager [enroll|operator-manifest|version|preflight]")
}

type preflightReport struct {
	Version              int    `json:"version"`
	Type                 string `json:"type"`
	Status               string `json:"status"`
	ControlPlaneVerified bool   `json:"controlPlaneVerified"`
}

func localPreflightReport() preflightReport {
	return preflightReport{Version: 1, Type: "native-packager-preflight", Status: "local-ready", ControlPlaneVerified: false}
}
