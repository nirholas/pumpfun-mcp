---
name: pumpfun-analysis
description: Analyse pump.fun coins and creators on Solana with the read-only pumpfun MCP server: bonding curve progress, top holders, trades, creator fee claims, SNS names and swap quotes. Use when asked about a pump.fun mint, a creator wallet or a .sol name.
---

# pump.fun analysis with the pumpfun MCP server

The plugin starts `npx -y @three-ws/pumpfun-mcp` (stdio). Every call is read-only: nothing signs or sends a transaction. No API key, RPC URL or wallet is needed. The package forwards requests to the hosted backend `https://three.ws/api/pump-fun-mcp`. To point it at your own deployment, export `PUMPFUN_MCP_URL` in your shell before starting Claude Code.

## Tools (names as registered in `src/tools.js`)

On-chain, always available on the hosted backend:

- `get_bonding_curve` (`mint`): real and virtual reserves and graduation progress. Only for coins that have not graduated.
- `get_token_trades` (`mint`, `limit` 1-200): recent buys and sells. `pumpfun_watch_whales` shows only large trades.
- `get_token_holders` (`mint`, `limit` 1-20, `network` mainnet or devnet): top holders with concentration analysis.
- `pumpfun_list_claims` (`creator` wallet, `limit` 1-50, `network`): recent creator fee-claim events with signature, mint, lamports and timestamp. `pumpfun_watch_claims` and `pumpfun_first_claims` cover recent windows and first-time claims.
- `sns_resolve` (`name`, e.g. `bonfida.sol`) and `sns_reverseLookup`: Solana Name Service lookups.
- `pumpfun_quote_swap` (`inputMint`, `outputMint`, `amountIn` in raw base units, `slippageBps`): quote for a graduated coin on PumpSwap. One side must be wSOL. Honour the returned `expiresAtMs`.
- `kol_leaderboard`, `social_cashtag_sentiment`, `social_x_post_impact`: social and KOL signals.
- `pumpfun_vanity_mint`: returns a vanity keypair for you to use yourself.
- `pumpfun_token_3d`: builds a shareable 3D snapshot for a mint.
- `pumpfun_bot_status`: shows whether the optional indexer is configured.

Indexer-gated: `search_tokens`, `get_trending_tokens`, `get_new_tokens`, `get_graduated_tokens`, `get_king_of_the_hill`, `get_creator_profile`. The hosted backend has no indexer, so these do not appear in its tool list. Without it `get_token_details` returns SPL account facts only, with `name`, `symbol` and `uri` null. Call `pumpfun_bot_status` first when one of these is missing.

## Worked example: is this coin safe to look at?

1. `get_bonding_curve` with the mint. If `complete` is true the coin graduated, so use `pumpfun_quote_swap` for price and depth instead.
2. `get_token_holders` with `limit: 10`. Report how much supply the top wallets hold.
3. `get_token_trades` with `limit: 50`. Note whether flow is mostly buys or sells.
4. If you know the creator wallet, `pumpfun_list_claims` shows what they already cashed out.

Report numbers as returned, say which tools were unavailable, and never present a quote as a trade recommendation.
