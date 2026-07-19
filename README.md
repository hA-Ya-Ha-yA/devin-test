# 路線図メーカー (rail-route-map)

日本の鉄道路線を選んで地図上に経路を描画し、その地図を **PNG 画像** として保存できる Web アプリです。

![screenshot](docs/screenshot.png)

## 特徴

- 主要な鉄道路線（JR・地下鉄・大手私鉄・新幹線など）をエリア / 検索で選択
- 一覧にない路線も OpenStreetMap の路線名で自由に検索して表示
- 地名や道路を含まないシンプルな地図（都道府県の境界線のみ）に描画
- 路線上に駅ポイントと駅名を表示
- 表示中の地図（路線・駅名・路線名キャプション入り）をワンクリックで画像保存

## 仕組み

- 地図描画: [Leaflet](https://leafletjs.com/)。背景タイルは使わず、都道府県境界の GeoJSON（`public/data/japan-prefectures.geojson`）のみを描画
- 路線・駅ジオメトリ: [Overpass API](https://overpass-api.de/)（OpenStreetMap の `type=route` リレーション。メンバーの way を経路、`stop` ロールのノードを駅として抽出）
  - バックエンド（Cloudflare Worker）が Overpass へ問い合わせ、結果を Cloudflare Cache API に 30 日キャッシュします
- 画像生成: Canvas に 都道府県境界 → 経路 → 駅ポイント/駅名 → 路線名キャプション の順で描画して PNG 出力
- 実行基盤: [Hono](https://hono.dev/) 上の [Cloudflare Workers](https://developers.cloudflare.com/workers/)（API）＋ [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)（`public/` のフロント配信）

## ローカル開発

```bash
npm install
npm run dev        # wrangler dev（既定で http://localhost:8787）
```

`public/` は Static Assets として配信され、`/api/*` は `src/index.js` の Worker が処理します。

## Cloudflare へのデプロイ

```bash
# 初回のみ: Cloudflare アカウントにログイン
npx wrangler login

# デプロイ
npm run deploy     # = wrangler deploy
```

設定は `wrangler.toml`（`name` / `main` / `[assets]`）を参照してください。
GitHub 連携でデプロイする場合の Cloudflare 側設定:

- Deploy command: `npx wrangler deploy`
- Build command: （不要。`wrangler deploy` がバンドルします）

キャッシュは Cloudflare Cache API を使うため追加のリソース作成は不要です。

## API

| エンドポイント | 説明 |
| --- | --- |
| `GET /api/lines` | 収録路線の一覧 (JSON) |
| `GET /api/route?id=<lineId>` | 収録路線の経路を GeoJSON で取得 |
| `GET /api/route?name=<名前>&operator=<事業者>` | 任意の路線名で経路を取得 |
| `GET /api/search?q=<語>` | 路線一覧を絞り込み |

## 路線の追加

`data/lines.json` に 1 件追加するだけです。

```json
{
  "id": "tobu-tojo",
  "name": "東武東上線",
  "operator": "東武鉄道",
  "region": "関東",
  "color": "#0067c0",
  "nameRegex": "東上線",
  "operatorRegex": "東武鉄道"
}
```

`nameRegex` / `operatorRegex` は Overpass の `name` / `operator` タグに対する正規表現です。
該当するリレーションのジオメトリをすべて結合して描画します。

## データ出典

- 路線・駅データ: © OpenStreetMap contributors（[ODbL](https://www.openstreetmap.org/copyright)）
- 都道府県境界: [dataofjapan/land](https://github.com/dataofjapan/land)（japan.geojson を簡略化して同梱）
