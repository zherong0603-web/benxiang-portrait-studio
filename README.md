# 本相 · Public engineering edition

本相 is a portrait studio application. This public snapshot contains the UI, routes, local D1/R2 schema, and workflow code for uploads, creation sessions, review, and private downloads. The nine bundled images are synthetic geometric fixtures. Prompt compilers emit synthetic demo text.

The snapshot excludes the private repository and its history, production settings, private photography recipes, research and payment records, customer photos, and credentials. It does not provide access to a hosted service. This project has no published project-wide license; included third-party notices apply to their respective files.

## Run locally

Use Node.js 22.13 or newer and npm on macOS or Linux. The HTTP suite also requires Python 3.

```sh
npm ci
npm run dev:studio
```

Open [the local experience](http://127.0.0.1:5173/experience) and use the local mock sign-in. Use synthetic inputs. The local preview binds to loopback, applies the checked-in D1 migrations, and uses local R2 storage. Local mock sign-in does not validate production authentication. No payment or external generation credentials are needed, and those paths are disabled for the preview.

```sh
npm test
npm run typecheck
npm run qa:local
```

The HTTP suite builds the Worker, creates temporary local D1/R2 stores, and exercises the upload, creation, review, delivery, and disabled payment/generation flows. It uses loopback fixtures and removes its temporary stores afterward. It does not check live payments, model output, or portrait likeness.

## 代码审计阅读顺序

| 问题 | 起点 |
| --- | --- |
| 工作台如何上传、选款和显示进度？ | `components/studio.tsx`、`components/portrait-experience.tsx` |
| 创建任务、计费保护、生成和恢复如何连接？ | `app/api/creations/`、`lib/creations.ts`、`lib/hosted-generation.ts`、`lib/generation-budget.ts` |
| 图片如何存储和授权下载？ | `db/schema.ts`、`lib/privacy.ts`、`app/api/assets/`、`drizzle/` |
| 订单、支付与回调的代码在哪里？ | `lib/commerce.ts`、`lib/payment-provider.ts`、`app/api/orders/` |
| 哪些结论可以由回归检查支持？ | `scripts/product/`；本版使用合成素材和中性配方，不能用于评估真实提示词、真人相似度或线上交易。 |

维护者在同一 GitHub 账号下提供单独的私有审计仓。具备访问权限的审查者从私有仓的 `AUDIT_START.md` 开始核对真实配方和验证记录。
