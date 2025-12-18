# Base Bonsai — Farcaster Mini App

**Production domain (must match manifest & embeds):** https://nurrabby.com

## Install
```bash
npm install
```

## Dev
```bash
npm run dev
```

## Build / Preview
```bash
npm run build
npm run preview
```

## Verify
- Manifest: https://nurrabby.com/.well-known/farcaster.json
- Embed image: https://nurrabby.com/assets/embed-3x2.png

## Notes
- `accountAssociation` in `public/.well-known/farcaster.json` is blank. Generate it with Base Build's account association tool and paste it in before publishing.
