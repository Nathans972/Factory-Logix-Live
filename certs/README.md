# certs

Only needed when FactoryLogix is reached over `https://` and its certificate is self-signed or
issued by your plant's own CA. Put that CA's certificate here in PEM form (a text file that starts
with `-----BEGIN CERTIFICATE-----`), set `FACTORYLOGIX_CA_CERT` in `.env` to its file name (for
example `FACTORYLOGIX_CA_CERT=plant-ca.pem`), and run `docker compose up -d`.

The `api` and `collector` containers see this folder, read-only, as `/app/certs`. Git ignores
everything here except this file. Step by step: `docs/INSTALL.md`, section 10.
