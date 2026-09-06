# ETH gas recovery (fee plan v2)

New conversions repay their funding address in native ETH before the remaining
Ethereum conversion and Vortex deposit. They do not accumulate small token fees
and wait for a future sweep. Existing user ETH is used before lending gas.

## Route behavior

| Deposit | When the user has enough ETH | When the user lacks ETH |
| --- | --- | --- |
| ETH | Selected input pays one platform fee; a separate ETH reserve covers gas. | Require enough ETH for input and the accepted gas reserve. |
| USDT / USDC | Pay the platform fee in ETH and convert the selected tokens. | Advance only the approval/recovery shortfall. Swap a capped token slice to exact-output native ETH, repay the sponsor, then use the user's resulting ETH for the remaining route. |
| SOL, route T | User pays the Wormhole redeem. Its native ETH output funds the rest. | Sponsor submits only the Wormhole redeem. The arriving ETH repays that gas and funds every later ETH transaction. |
| SOL, route S | User must cover redemption, bridge gas, and the platform fee in ETH. | Unavailable. Use route T; vKOIN does not supply an executable native ETH recovery path in this implementation. |

USDT/USDC recovery uses SwapRouter02 `multicall(uint256,bytes[])` containing
`exactOutputSingle` to WETH and `unwrapWETH9` to the user's transit address.
The exact ETH output, maximum token input and deadline are enforced together.
USDT allowance resets are included when necessary. A missing recovery quote
prevents an advance.

## Accounting and estimates

Every signed Ethereum transaction is journaled before broadcast. After the
configured confirmation count, the ledger records actual `gasUsed * gasPrice`,
including reverted transactions. Receipt hashes deduplicate costs. Successful
advances are principal; the gas paid with an advance is not counted as a second
sponsor expense.

The single ETH settlement pays:

```
outstanding successful advances + sponsor-paid gas
+ risk charge on actual sponsor cost
+ accepted platform fee
```

The risk charge defaults to 20% of actual sponsor cost, and the platform fee
defaults to 1% of the quoted input value. These are explicit charges, separate
from gas headroom. The risk charge helps replenish losses on failed jobs; it
cannot guarantee that a particular failure rate is profitable.

The fee quote includes expected Ethereum gas and an approved ceiling covering
the applicable funding transfer, approvals, ETH recovery swap, repayment
transfer, conversion, bridge deposit, and a signature-renewal contingency.
It adds the fixed platform fee and maximum risk charge. Gas limits and price
ceilings bound execution; unused gas headroom is not collected as a fee.
Unused purchased ETH remains at the user's deposit address.

The quote also discloses the maximum token slice for recovery and separately
available ETH that may be spent, including ETH deposited while a route runs.
The KOIN estimate includes input deductions. Route ranking additionally
accounts for fees paid from existing ETH, without reducing delivery twice.
Exchange fees and price impact are embedded in swap quotes. Solana fees and
account rent are paid separately from the displayed SOL reserve; they are
not covered by the Ethereum fee ceiling. USD amounts are indicative at quote
time; limits are enforced in ETH and token units.

Quotes bind account, asset, amount and route, expire after 60 seconds by
default, and must be accepted via `quoteId`. Restarting the server invalidates
unaccepted quotes. Accepted jobs retain their limits across restarts. A route
may pause if gas or prices exceed those limits; the minimum KOIN delivery is
conditional on completing the route. Users are not automatically charged a
higher ceiling to resume.

## Reserve controls and operation

| Setting | Default | Purpose |
| --- | --- | --- |
| `FUND_SPONSOR_MIN_ETH` | `0.002` | ETH kept below lending capacity. |
| `FUND_SPONSOR_MAX_ETH` | `0.005` | Maximum exposure for one job. |
| `FUND_SPONSOR_MAX_OUTSTANDING_ETH` | `0.02` | Debt plus unspent commitments across jobs. |
| `FUND_FEE_MAX_SPONSORED_USD` | `20` | Additional per-job cap, valued at the accepted ETH price. |
| `FUND_SPONSOR_RISK_BPS` | `2000` | Charge on actual sponsor cost, in basis points. |
| `FUND_GAS_HEADROOM_BPS` | `2000` | Gas-unit headroom. |
| `FUND_GAS_PRICE_HEADROOM_BPS` | `2500` | Quoted gas-price headroom. |
| `FUND_QUOTE_TTL_SECONDS` | `60` | Initial acceptance lifetime. |
| `FUND_ETH_CONFIRMATIONS` | `2` | Confirmations before settlement and progression. |

Admission reserves the maximum sponsor exposure before any source-chain swap.
Every sponsored send rechecks available ETH against the protected reserve and
other jobs' unspent commitments. Token balances never count as available ETH.
Actual money already sent is not subtracted from the wallet balance twice.
Outstanding debt remains visible when a job fails; resets cannot erase it.

`/api/config` exposes confirmed ETH, protected reserve, commitments, debt and
available capacity in `float`. A missing RPC balance or price pauses lending.
The funding key takes precedence over a separate fee treasury, and accepted
plans pin the repayment address. Keep the original sponsor configured until
its jobs have settled.

Run one process against a local durable data directory and use a dedicated
funding key. The directory lock is a single-host PID lock, not a distributed
lock. Do not share this key with another worker, manual sender, or deployment:
their nonces and spending would be outside this ledger's control. Persist the
data directory and back it up securely; it contains transit keys and signed
transactions. The ledger uses file and directory fsync plus atomic rename.

Lost Ethereum broadcast replies reuse the saved raw transaction and nonce.
Confirmed receipts survive a failure while processing delivered amounts.
New SOL transactions are also signed and saved before broadcast. Ethereum
retries retain the original per-step, total-gas and sponsorship caps. Exhausted
budgets, irrecoverable transactions, or changed minimum output require operator
reconciliation; this change does not implement a higher-budget reauthorization
workflow. A stalled transaction may need RPC/operator investigation.

These controls stop new lending before the configured reserve is spent by this
worker. They do not guarantee lossless cross-chain execution or protection from
external withdrawals, key compromise, deep reorganizations, or failed recovery
after an advance. Maintain working capital and monitor outstanding debt.

## Rollout and existing jobs

1. Keep this change out of production until the fork checks below are complete.
   Back up `funding.json` and inspect all unfinished jobs and legacy token fees.
2. Reconcile older advances from their on-chain transactions. Older records
   may lack the v2 receipt journal, and existing USDT/vKOIN treasury inventory
   is not automatically sold or counted as ETH backing. Do not assume a new
   successful job recovers historical losses.
3. Legacy jobs keep their existing flow; this patch refuses any new legacy
   sponsorship. Already-broadcast transactions can reconcile. Jobs requiring
   additional gas need the user's own ETH or explicit operator recovery.
   Legacy jobs are not silently migrated to new, higher fee limits.
4. Confirm the dedicated sponsor and a plain ETH-receiving address are correct,
   choose reserves appropriate to workload, and run a single worker. Check
   the exposed float metrics before enabling new sponsored jobs.
5. After validation and deployment approval, start with small limits. Compare
   each sponsor outflow and repayment against its ledger, including reverts.
   Adjust the risk charge using observed losses rather than assuming 20% is
   sufficient for every market and failure rate.

## Verification

`npm test` runs deterministic route simulations with real ABI builders and
transaction signatures, plus the existing wallet regression suites. Added
coverage includes USDT/USDC recovery, ETH B/C, SOL S/T, user ETH precedence,
partial shortfalls, missing reverse quotes, reserve admission, pending nonce
allocation, reverted gas, gas spikes, interrupted receipt processing and
restart replay. UI quotes pass the accepted quote ID into the start API.

The recovery calldata is decoded against an independent SwapRouter02 ABI
fixture. This is not execution against deployed contracts. Public Ethereum
RPC probes timed out in the implementation environment, so mainnet/fork
execution and live end-to-end conversion have not been validated here.

Before merging, use an isolated Ethereum mainnet fork to exercise both stable
recovery pools, USDT zero/nonzero allowances, multicall unwrapping, actual gas
estimates, and repayment to the configured EOA. Exercise Wormhole native ETH
redemption using a valid test transfer and the Vortex tail with representative
state. Verify that fixed per-step gas estimates fit the deployed contracts at
the configured headroom. Test a crash after broadcast and before receipt
processing, and validate the ledger against the fork's sponsor balance. No
production funds should be used for these fork checks.
