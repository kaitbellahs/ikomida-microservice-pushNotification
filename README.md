# ikomida-microservice-pushNotification

Device registration and notification history.

> Part of the **iKomida** platform. See **[ikomida-k8s-config](https://github.com/kaitbellahs/ikomida-k8s-config)** for the architecture overview of all 31 repositories.

---

## Role

Registers devices for push and serves the notification history for both clients and vendors. Actual delivery is asynchronous — this service publishes to a queue and [worker-push-notification](https://github.com/kaitbellahs/ikomida-worker-push-notification) does the sending.

## Endpoints

As declared in the [gateway route table](https://github.com/kaitbellahs/ikomida-microservice-gateway/blob/dev/src/routes.ts) (4 routes reach this service):

| Method | Path | Roles |
|---|---|---|
| `POST` | `/notification/register` | *public* |
| `GET` | `/vendor/pushNotifications/:timestamp` | VENDOR, STAFF, ADMIN |
| `GET` | `/pushNotifications/:timestamp` | ALL |
| `POST` | `/vendor/pushNotification` | VENDOR, STAFF, ADMIN |

## Stack

TypeScript (ESM) · Express · Sequelize · rollup · Docker · Kubernetes

Depends on [`@ikomida/shared-types`](https://github.com/kaitbellahs/ikomida-shared-types), [`@ikomida/shared-backend`](https://github.com/kaitbellahs/ikomida-shared-backend) and [`@ikomida/shared-logics`](https://github.com/kaitbellahs/ikomida-shared-logics).

## Build

```bash
yarn install
yarn build      # rollup bundle
yarn service    # run locally
```

## Status

Built in 2022. The platform is no longer deployed; this repository is published as a record of the work. **The commit history predates generative AI coding assistants.**

## License

Licensed under the [Apache License 2.0](LICENSE) — free for commercial use, provided the copyright notice and [NOTICE](NOTICE) are retained.

Copyright 2022 Khalid Ait Bellahs.
