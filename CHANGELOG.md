# Changelog

## [0.4.0](https://github.com/kturnal/WhatsApp-poller/compare/whatsapp-poller-v0.3.2...whatsapp-poller-v0.4.0) (2026-03-16)


### Features

* improve first-run setup flow ([32799d4](https://github.com/kturnal/WhatsApp-poller/commit/32799d4465a089c6dba68e8441c7ddb6ac87a6c5))
* improve first-run setup flow ([a987307](https://github.com/kturnal/WhatsApp-poller/commit/a987307229249eb1cb168052780492e5a01cd408))


### Bug Fixes

* add explicit health server host binding ([745bd56](https://github.com/kturnal/WhatsApp-poller/commit/745bd56b3ae72c5f2e761092dc54b77a63902f58))
* add explicit health server host binding ([9f64c9a](https://github.com/kturnal/WhatsApp-poller/commit/9f64c9ae678d7ee192cf884e771f88b05b283457))
* address review feedback ([005e325](https://github.com/kturnal/WhatsApp-poller/commit/005e3254934290c4b4d1554e42553c0ad705edd8))
* address review findings ([353c800](https://github.com/kturnal/WhatsApp-poller/commit/353c8006df21b4cee6d2474ba5ce436d86fd3783))
* align startup catch-up with poll cron ([65c4389](https://github.com/kturnal/WhatsApp-poller/commit/65c438927fca8fcfb135741d56a0a387a04ee72a))
* override vulnerable transitive dependencies ([b129254](https://github.com/kturnal/WhatsApp-poller/commit/b129254144aba60a032358d1302453f7b33cc0b6))
* scope yauzl override to puppeteer subtree ([e181ac1](https://github.com/kturnal/WhatsApp-poller/commit/e181ac1bfcf75552c26e28d29e9e4cc9eb555634))

## [0.3.2](https://github.com/kturnal/WhatsApp-poller/compare/whatsapp-poller-v0.3.1...whatsapp-poller-v0.3.2) (2026-03-10)

### Bug Fixes

- skip expired automatic winner announcements ([ed6e319](https://github.com/kturnal/WhatsApp-poller/commit/ed6e319a24539efe6852ede3c1a11cbabfd937ea))

## [0.3.1](https://github.com/kturnal/WhatsApp-poller/compare/whatsapp-poller-v0.3.0...whatsapp-poller-v0.3.1) (2026-03-01)

### Bug Fixes

- ignore nested DATA_DIR symlinks during hardening ([cc32a7b](https://github.com/kturnal/WhatsApp-poller/commit/cc32a7ba31db772a59fc23db49b707fd0216ce14))
- ignore nested DATA_DIR symlinks during hardening ([3ba5b92](https://github.com/kturnal/WhatsApp-poller/commit/3ba5b9204ac1a6010d381d3073e091a9d030436c))
- prevent startup failure from Chromium session symlinks ([5592b8d](https://github.com/kturnal/WhatsApp-poller/commit/5592b8de51e528b7c4400c94960d96630ebfb606))
- resolve [@lid](https://github.com/lid) voter mapping and command guard parsing ([f93f9d0](https://github.com/kturnal/WhatsApp-poller/commit/f93f9d098ca864e8eba38e7bc9ed7c5b5df572e4))

## [0.3.0](https://github.com/kturnal/WhatsApp-poller/compare/whatsapp-poller-v0.2.0...whatsapp-poller-v0.3.0) (2026-03-01)

### Features

- add health endpoints and operational metrics ([3ba8e8c](https://github.com/kturnal/WhatsApp-poller/commit/3ba8e8c7725fe382520d78d3f880bce344860946))
- add health endpoints and runtime metrics ([c1809ed](https://github.com/kturnal/WhatsApp-poller/commit/c1809ed4642503dda2585e03db4795b4bce2f626))
- add initial WhatsApp poller implementation ([d0d251e](https://github.com/kturnal/WhatsApp-poller/commit/d0d251ee7febcda44a7592ceb7c215474d2ef8ea))
- add interactive startup week selection mode ([dc8233b](https://github.com/kturnal/WhatsApp-poller/commit/dc8233b9e49bdfe847f90b0ce47cd8058631a0dc))
- **ci:** add automated release workflow with release-please ([46490e4](https://github.com/kturnal/WhatsApp-poller/commit/46490e4ef5ea14007a6f15339b375c0a5ef2a913))
- **ci:** automate releases with release-please ([957655a](https://github.com/kturnal/WhatsApp-poller/commit/957655aeebd8878895b1a275a26f2e79fa42f7c4))
- harden bot security and onboarding workflows ([4f19131](https://github.com/kturnal/WhatsApp-poller/commit/4f1913171e88d9f73055afc787d18fde96df1ca6))
- interactive startup calendar-week selection for poll target week ([26c7688](https://github.com/kturnal/WhatsApp-poller/commit/26c76882cec18f4c00bfe3a055f8c844a15fe0b9))
- make weekly poll slot options configurable ([0f4070d](https://github.com/kturnal/WhatsApp-poller/commit/0f4070d1354f88f9ac6d289af27b1272c32c0e2c))
- make weekly poll slot template configurable ([b4e34ea](https://github.com/kturnal/WhatsApp-poller/commit/b4e34ea660fb57a7c2eda8e276309bb944d754a9))
- reconcile poll votes on startup (fix [#13](https://github.com/kturnal/WhatsApp-poller/issues/13)) ([638a26a](https://github.com/kturnal/WhatsApp-poller/commit/638a26a24bd66be2cac82ec1b94e3eee4a90f096))
- reconcile poll votes on startup (fix [#13](https://github.com/kturnal/WhatsApp-poller/issues/13)) ([8e77309](https://github.com/kturnal/WhatsApp-poller/commit/8e7730908de9b8849d257e553d7977e2349b51c9))

### Bug Fixes

- address observability review findings ([3a04945](https://github.com/kturnal/WhatsApp-poller/commit/3a04945cf6c55650d82079c22c2c2bd223d80456))
- address review findings for CI, docs, config and migration safety ([68c00d6](https://github.com/kturnal/WhatsApp-poller/commit/68c00d6ce60278bb420e654f7b70afdff00ed6a8))
- apply coderabbit PR review ([041228a](https://github.com/kturnal/WhatsApp-poller/commit/041228afbff53cc10fad1b8ccbe41e84b876b307))
- **ci:** use PAT for release-please token ([8284036](https://github.com/kturnal/WhatsApp-poller/commit/82840369447f4cd19dc48d7bcf459290fbd99e2a))
- **ci:** use PAT for release-please token ([7209c12](https://github.com/kturnal/WhatsApp-poller/commit/7209c12efc5e032bfd5af3aba2095a155548e1e9))
- resolve npm audit minimatch vulnerabilities ([035bf41](https://github.com/kturnal/WhatsApp-poller/commit/035bf4166c71bae03561690df8298bf3b18ab71c))

## [0.2.0](https://github.com/kturnal/WhatsApp-poller/compare/whatsapp-poller-v0.1.0...whatsapp-poller-v0.2.0) (2026-02-27)

### Features

- add health endpoints and operational metrics ([3ba8e8c](https://github.com/kturnal/WhatsApp-poller/commit/3ba8e8c7725fe382520d78d3f880bce344860946))
- add health endpoints and runtime metrics ([c1809ed](https://github.com/kturnal/WhatsApp-poller/commit/c1809ed4642503dda2585e03db4795b4bce2f626))
- add initial WhatsApp poller implementation ([d0d251e](https://github.com/kturnal/WhatsApp-poller/commit/d0d251ee7febcda44a7592ceb7c215474d2ef8ea))
- **ci:** add automated release workflow with release-please ([46490e4](https://github.com/kturnal/WhatsApp-poller/commit/46490e4ef5ea14007a6f15339b375c0a5ef2a913))
- **ci:** automate releases with release-please ([957655a](https://github.com/kturnal/WhatsApp-poller/commit/957655aeebd8878895b1a275a26f2e79fa42f7c4))
- harden bot security and onboarding workflows ([4f19131](https://github.com/kturnal/WhatsApp-poller/commit/4f1913171e88d9f73055afc787d18fde96df1ca6))
- reconcile poll votes on startup (fix [#13](https://github.com/kturnal/WhatsApp-poller/issues/13)) ([638a26a](https://github.com/kturnal/WhatsApp-poller/commit/638a26a24bd66be2cac82ec1b94e3eee4a90f096))
- reconcile poll votes on startup (fix [#13](https://github.com/kturnal/WhatsApp-poller/issues/13)) ([8e77309](https://github.com/kturnal/WhatsApp-poller/commit/8e7730908de9b8849d257e553d7977e2349b51c9))

### Bug Fixes

- address observability review findings ([3a04945](https://github.com/kturnal/WhatsApp-poller/commit/3a04945cf6c55650d82079c22c2c2bd223d80456))
- address review findings for CI, docs, config and migration safety ([68c00d6](https://github.com/kturnal/WhatsApp-poller/commit/68c00d6ce60278bb420e654f7b70afdff00ed6a8))
- apply coderabbit PR review ([041228a](https://github.com/kturnal/WhatsApp-poller/commit/041228afbff53cc10fad1b8ccbe41e84b876b307))
- resolve npm audit minimatch vulnerabilities ([035bf41](https://github.com/kturnal/WhatsApp-poller/commit/035bf4166c71bae03561690df8298bf3b18ab71c))

## Changelog

All notable changes to this project will be documented in this file.
