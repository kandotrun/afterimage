# Security policy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose camera footage, credentials, file paths, or host files.

Send a private report through [GitHub Security Advisories](https://github.com/kandotrun/afterimage/security/advisories/new) with:

- affected version or commit
- reproduction steps
- expected impact
- any suggested mitigation

You should receive an acknowledgement within 72 hours.

## Deployment guidance

Camera lifelogs are highly sensitive data.

- Configure `AFTERIMAGE_AUTH_TOKEN` or Basic credentials before binding to a non-loopback interface.
- Put internet-facing deployments behind TLS.
- Prefer a private network, VPN, or authenticated reverse proxy.
- Mount the storage root read-only in the server container when ingestion runs separately.
- Never commit `.env`, source videos, transcripts, scenes, or generated memory files.
- Treat VLM/STT providers as data processors: sampled images or audio leave the machine when a hosted provider is enabled.

`/_health` is intentionally public and returns no personal data. Every other route is protected when authentication is configured.
