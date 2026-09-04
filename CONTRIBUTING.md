# Contributing

Use Node 24, the locked npm dependencies, and the pinned Foundry submodule. Run `npm run ci` and the disposable Postgres security suite before proposing changes. Add adversarial tests for payment, authentication, wallet and database transitions. Do not weaken launch gates to make a demo appear successful.

Contributions are MIT licensed. Only contribute code and assets you may legally license. Never include customer data, real transactions tied to identities, credentials, deployment configuration, private reports or signing material. Report vulnerabilities through private security advisories, not public issues.

Public CI has read-only permissions and no deployment or provider credentials. Maintainers review an exact commit and rebuild it in the separately controlled private deployment workflow. Never run untrusted contributor code with production secrets or use `pull_request_target` to check out contributor code.
