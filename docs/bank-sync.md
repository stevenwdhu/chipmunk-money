# Bank sync

Add any of these services in **App settings → Bank sync**. They work side by side, each with its own connections and schedule:

- **[SimpleFIN Bridge](https://bridge.simplefin.org)** (US$15 a year, up to 25 banks) reaches most Canadian banks (RBC, TD, Scotiabank, Wealthsimple, Tangerine and more) through MX. [Check yours](https://bridge.simplefin.org/search-institutions). Rogers Bank, for one, isn't available. You connect your banks on SimpleFIN's site, and the app reads them all through one connection.
- **[Plaid](https://plaid.com)** with your own API keys. Plaid's free Trial plan (US and Canada) covers 10 bank logins. You sign in to each bank in Plaid's own window, and the first sync brings up to two years of history.
- **Wealthsimple** (unofficial), with your Wealthsimple sign-in. See [below](#wealthsimple-unofficial) before you use it.

Choose how often each one syncs under **Sync**: every 6 hours by default for SimpleFIN (every 2 hours at the most), every 2 hours for Wealthsimple and every hour for Plaid.

**Remove…** in a service's menu removes all its connections (for Plaid, ending its access to your banks, and deleting your Plaid keys). Their accounts stop syncing, and the transactions already synced stay.

## SimpleFIN Bridge

1. Sign up at SimpleFIN Bridge and connect your banks there.
2. Create a setup token (Bridge → *New app connection*) and paste it into **App settings → Bank sync**.

SimpleFIN allows about 24 updates a day, so the app stays under 20 per connection and syncs every 2 hours at the most. It signs in to your bank on your behalf, and some banks only guarantee fraud losses if you never share your password, so check your bank's online banking agreement.

## Plaid

1. Sign up at [Plaid](https://dashboard.plaid.com/signup) and copy your client ID and a secret from *Developers → Keys*: the Sandbox secret to try it with Plaid's test banks (sign in with `user_good` / `pass_good`), or the Production one for your real banks.
2. Add **Plaid** in **App settings → Bank sync**, save the keys with the matching environment (or set the `PLAID_*` variables), and choose **Connect a bank**.
3. Sign in to your bank in Plaid's window. Each bank login becomes one connection. When a bank wants you to sign in again, its connection shows **Reconnect**.

Plaid itself checks your bank 1 to 4 times a day, so syncing more often than hourly wouldn't bring transactions sooner. **Sync now** gets what Plaid already has.

## Wealthsimple (unofficial)

Wealthsimple has no public API. This uses the private API Wealthsimple's own web app uses, following the open-source [ws-api-python](https://github.com/gboudreau/ws-api-python). It isn't made or supported by Wealthsimple, it can break or be blocked at any time, and using it may go against Wealthsimple's terms. Use it at your own risk, or reach Wealthsimple through SimpleFIN instead.

1. Add **Wealthsimple** in **App settings → Bank sync**.
2. Sign in with your Wealthsimple email, password and 2FA code.

The password is used once and never stored. Only the session is kept, encrypted with `secret.key`. It's read-only: the app sees your accounts, balances and activity, and can't move money. When Wealthsimple ends the session, sign in again.

## Linking accounts

Set each account to synced in its own settings (**Edit account → Updates → Synced**, then pick the bank account), or use **Add as account** in App settings → Bank sync for a new one. Transactions you already have are matched, not duplicated.

Synced or manual is part of an account's settings, and you can switch either way at any time: going manual keeps every transaction (they just stop updating), and going back to synced picks up where it left off without duplicates.

What happens on each sync (on your schedule, or **Sync now**):
- New transactions are added and categorized from your history (and AI, if it's set up). They show up in the review queue like an import.
- Your edits stick: the bank updates dates, amounts and pending status, but never your payee, category, notes or tags. Correct a synced transaction's amount or date (when the bank got it wrong) and syncs leave those alone too, and don't remove it. **Resume syncing** in the transaction undoes that.
- What the bank sends for each transaction is kept as it sent it (the service's JSON), when it's new and each time it changes or is removed. Open a synced transaction and choose **See what the bank sent**, or call `GET /api/v1/ledgers/{ledger}/transactions/{id}/bank-data`.
- **Fetch all history** (in a connection's ⋯ menu, after a confirmation) asks for everything again instead of only what's new: up to 2 years from Plaid, the last 90 days from SimpleFIN. Nothing is added twice.
- A pending charge that posts (even under a new id or a slightly different amount) updates the same transaction. Pending charges that disappear are removed.
- Transactions you had entered or imported are matched instead of added twice.
- A synced account's balance is always the bank's. Investment, loan and property accounts take the bank's balance instead of importing transactions. For the others, each sync moves the opening balance so the transactions add up to what the bank shows. Only manual accounts can have their balance set by hand.
- Each sync is in **Activity** as *SimpleFIN sync*, *Plaid sync* or *Wealthsimple sync*.
- A service that doesn't answer within 30 seconds fails that sync with a message, and the next one tries again.

After each sync and CSV import, the app also recognizes:
- **Refunds:** money back on the same account from a merchant you bought from in the last 60 days. It takes that purchase's category (and follows it if you change it), so spending nets out, and shows a **Refund** mark. The same amount is applied outright. A partial refund ($1 or more) is suggested for review. Interac e-Transfers are money to and from people, so they're never refunds.
- **Credit card payments:** other money onto a credit card, except cash back, rewards and credits from a merchant you buy from. It's paired as a transfer with the withdrawal from chequing or savings that paid it (the same amount, within 5 days), so neither side counts as spending or income. Without one, it goes in your *Credit card payment* category, or *Transfer*, or stays uncategorized. A category your history is sure of (cash back, say) stays.
- **The bank's category:** Plaid sends one with each transaction. AI sees it as a second opinion. When Plaid is sure, the AI agrees and is fairly sure itself, the category is applied without review. It's shown in the transaction's details.

These only change what's uncategorized or still waiting for your review, never a category you chose or accepted. To run them over all your existing transactions, use `POST /api/v1/ledgers/{ledger}/transactions/match` (add `?dryRun=true` to preview the counts). **Not a refund** and **Not a transfer** in a transaction's details undo a match, and it isn't made again.

The access each connection gives the app, and your Plaid secret, are stored encrypted with `secret.key`, which backups leave out.

## Shared accounts

A credit card [shared between ledgers](features.md#shared-accounts) is still one account at the bank. It's linked, synced and switched in its home ledger, and the other ledgers that have it show **Managed in Personal** in its place. One sync covers the whole card, whichever ledger holds each transaction:

- **New transactions land in the home,** categorized from the home's history, in the home's review queue. Move the ones that belong to another ledger.
- **A transaction another ledger holds is updated where it is.** The bank's date, amount and pending status reach it there, and that ledger's payee, category, notes and tags stay.
- **A pending charge you moved** to another ledger updates the same transaction there when it posts, also under a new id. Nothing new appears in the home. When the bank drops a pending charge and sends it again within 7 days, the removed one comes back in the ledger that had it. One a person deleted is never brought back.
- **When the bank removes a transaction,** it's removed in the ledger that holds it. A transaction any ledger deleted stays deleted, and isn't added again in the home.
- **The bank's balance is the whole account's.** Each ledger's balance is what it holds, and the ledger that carries the card's starting balance takes up any difference between the transactions and the bank.
- **A payment split between ledgers** is the bank's transaction like any other. A new date or pending status is copied to its shares. A new amount stays with the ledger that holds the payment, and the payment says "The shares are more than the payment now" when that's so. If the bank removes the payment, its split is undone first.
- **Fetch all history** works the same way. Nothing is added twice, in any ledger.
- **After a ledger stopped sharing the card and kept its transactions** on an account of its own, the card still knows them. A sync never adds them to the card again, and never updates or removes them on the account they're on now, which isn't synced.
- Each ledger a sync changed has it in its own **Activity**.

**Switching the bank account** a shared account syncs from is allowed, in the home. **Review before switching** compares every ledger's transactions with the bank's and names the ledger beside each one another ledger holds ("Family", or "Family · Visa" for one on an account a ledger kept when it stopped sharing). Paired transactions take the bank's ids where they are, the bank's others are added in the home, and one you choose to remove is removed in its own ledger. A split payment can be paired but not removed until its split is undone, and a transaction on a kept account always stays.

**CSV import** into a shared account is done in the home, and the rows land there. A row that's already a transaction in another ledger is a duplicate too: it's unticked, marked **Already in another ledger**, and skipped.

What an API key limited to some ledgers can do with a shared account is in [Security](security.md).
