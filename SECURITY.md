# Security Policy

m6t runs with the user's own credentials (kubeconfig, SSH keys, git credential
helpers) and executes local binaries on their behalf. Vulnerabilities in the
loopback stream server, the exec wrappers, or credential handling are taken
seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately via
[GitHub security advisories](https://github.com/txn2/m6t/security/advisories/new)
or email **cjimti@gmail.com** with a description and reproduction steps.

You will get an acknowledgment within a few days. Please allow a reasonable
window for a fix before public disclosure.

## Supported versions

Pre-release: only the latest `main` is supported.
