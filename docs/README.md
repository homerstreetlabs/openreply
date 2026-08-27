# OpenReply documentation

Four documents, in the order you need them.

| Document | What it is for |
| --- | --- |
| [setup.md](setup.md) | The operator guide. Hosting, environment, and the developer app for each of Instagram, Facebook, YouTube, and TikTok. Start here. |
| [deploy-cloudflare.md](deploy-cloudflare.md) | The ten deploy steps: Hyperdrive, queues, migration, email, both Workers, secrets, admin bootstrap, verify. |
| [stack.md](stack.md) | Reference. What runs where, the platform abstraction, the four rate-limit shapes, the cron table. |
| [app-review.md](app-review.md) | The review and verification gate on each platform, needed only when people who are not testers connect their own accounts. |

## Design record

[architecture/](architecture/) holds the design work that produced this system: verified
platform research, the capability matrix, the design and its open gaps, and the deploy-0
spike. It is a historical record rather than current documentation, and
[architecture/README.md](architecture/README.md) says which parts are superseded by
shipped code.
