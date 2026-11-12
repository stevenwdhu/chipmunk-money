# Features

Everything Chipmunk does, in more detail than the README.

- **Ledgers:** separate sets of books with their own accounts, categories and reports. Switch from the top of the sidebar (or the phone header). Each ledger has its own address (`/l/family/transactions`), so tabs and devices can sit in different ledgers.
- **Transactions:** quick add from a bottom sheet on your phone (or press <kbd>N</kbd> on desktop), transfers between accounts, tags, notes, search and filters, bulk edit, undo.
- **Smart categories:** the app suggests categories from the ones you've picked before, for money in and money out separately. When you set one, choose what happens to that payee: always that category (its other transactions waiting for review are done too, and new ones need no review), ask each time, or always review it yourself (for e-transfers and transfers that can be several things). Ledger settings → Payees lists your choices. New payees can go to an LLM of your choice (a primary provider and a fallback, both optional), and its suggestions wait for your review.
- **Accounts and net worth:** chequing, credit cards, cash, investments, loans and property, each under its institution (your bank, or e.g. "Wallet" for cash), which is how the sidebar groups them. Some accounts follow your transactions. Others you update by hand. Net worth history is included.
- **Shared accounts:** one credit card used by two sets of books can be in both ledgers. Each keeps its own transactions on it and its own part of the balance, transactions move between them, and a card payment can be split. See [Shared accounts](#shared-accounts) below.
- **Recurring items:** subscriptions and bills are detected from your history for you to confirm: three payments in a row on schedule, or four of the last seven due dates (one that came early doesn't break it, nor a name the bank changed), each within 5% and a day (plus weekends) of what's expected, both adjustable. One payee can have several, like iCloud and Apple Music. Instalment plans are recurring items with a number of payments: progress, what's left and when it ends, and they end on their own after the last payment. A payment at an amount of its own, like a down payment or a last payment that's the remainder, can be added to a plan by hand: it counts, and the plan's usual amount stays. Give a plan its full price (what Klarna or Affirm shows as the total of its payments) and its last payment is what's left of it: shown in what's left and what's coming up, expected when it comes, and kept apart from another plan's payment from the same payee. When the payments don't add up to the full price, the app offers the one that makes them add up exactly, like a down payment from before the others, and asks before taking a payment that came long after its due date. Pay in 4 plans (Klarna, Afterpay and others) are found after two payments, named after the store when the bank's description says, and plans you've already paid off are found too, with their full price, so your history is easy to organize. Any item can have a name of its own besides its payee, shared by all its payments. Other transactions can have their own name too, like "Suitcase". Names show in the transactions table's Name column, and search finds them. The app warns when a payment is missing or the price changed, and shows the next 30 days. When the bank starts sending a slightly different payee name, it asks whether that payment is the item's, and if it is, payments under the new name match from then on.
- **Reports:** spending by month and category, income vs spending, savings rate, top payees, tag totals and CSV export. Filter what counts (by category, tag, payee, words, amount, account or recurring, or one purchase at a time), for spending and income apart, to see your regular spending without the big one-offs, and compare it with the months before or a year before. Save a filter as a custom report: it opens the same on every device, and through MCP (`get_report`).
- **CSV import:** column mapping that remembers each bank, duplicate detection, categories from history, refunds and card payments recognized, and a list of recent imports. To take an import back, select its transactions and delete them.
- **Bank sync:** connect your banks through [SimpleFIN Bridge](https://www.simplefin.org/), [Plaid](https://plaid.com) or Wealthsimple (unofficial), side by side. Their transactions and balances arrive on a schedule you choose (from every hour to once a day), categorized from your history, with pending charges replaced when they post.
- **Settings:** *Ledger settings* (name and colour, which categories it uses, tags, CSV import and export, the full backup and how to restore it, erase) and *App settings* (time zone, appearance, managing all ledgers with a full backup, the shared categories, bank connections, AI providers with a connection test and usage log, API keys).
- **Categories:** one shared list of groups, categories and Needs/Wants labels in App settings, reordered by dragging their handles (a category can be dragged into another group). Each ledger turns off the ones it doesn't need (choosing where their transactions go), or keeps its own list instead. Switching back matches its categories to the shared list, asking about each one the list doesn't have.
- **API:** everything the app does goes through a documented [REST API](api.md) (`/api/v1`, interactive docs at `/api/docs`), so scripts and AI agents can do anything you can. Each agent gets its own API key with limited access, and **Activity** shows what each one changed.
- **[MCP server](mcp.md):** AI agents (Claude and others) connect at `/mcp` or over stdio to search transactions, work the review queue, add transactions, and answer questions about your spending.

## Shared accounts

One credit card is often used by two sets of books: your own spending and the family's, on the same Visa. Sharing the card puts it in both ledgers. Each transaction on it is in one ledger only. A ledger's balance on the card is what its own transactions add up to, and the ledgers' balances together are the account's total, which is what the bank says you owe.

Only credit cards can be shared for now.

### The home ledger

One of the ledgers that have the card is its **home**, the ledger the card was in when you shared it unless you choose another. Two things happen there:

- **New transactions land there.** Everything a bank sync or a CSV import brings goes to the home. From there you move what belongs to another ledger.
- **The account is looked after there.** Its name, type, starting balance and notes, its bank link, **Update balance**, **Import CSV**, **Share with…** and **Delete account** are in the home only.

### Sharing a card

Open the card in the ledger it's in and choose **Share with…** in its menu. The menu has it for a credit card, once there's more than one ledger. Tick the ledgers that should have the card, pick which one is its **Home**, and save.

Nothing already recorded moves and no balance changes. The other ledger gets the card under an institution of the same name, with no transactions on it yet. An archived ledger can't be given a card.

### What each ledger sees

- **Accounts** shows the card with a **Shared** mark and this ledger's balance on it, with the whole account's under it ("of $300.00"). In a ledger that isn't the home it says **Managed in Personal** where the sync status would be.
- **The account's page** shows "Owed in Family", and under it the whole account: "$300.00 owed on the whole account · Home: Personal". In the home that line ends "Shared with Family".
- **Its transactions** have a **This ledger / All ledgers** switch. *This ledger* is what this ledger holds. *All ledgers* is every ledger's, with a Ledger column and the whole account's balance after each one, so it reads like the bank's statement. Another ledger's transaction is read-only there ("In Family. Move it here to edit it."), and opening it shows its details with **Move to…**.
- Everything else (Transactions, the review queue, reports, recurring items, net worth) counts only what this ledger holds.

### Moving transactions between ledgers

**Move to…** sends a shared account's transactions to another ledger that has it, in any direction: from the bulk bar on a computer, from a transaction's own form, or from the All ledgers list (for rows that are all in one ledger). There's no undo. Moving one back is another move.

A moved transaction belongs to the other ledger from then on, and that ledger treats it as a new one:

- **Category:** kept when the other ledger has that category, or one of the same name. Otherwise it gets what that ledger's history suggests (to review), or goes to AI like any new transaction. A card payment or a transfer takes the other ledger's card payment or transfer category, so it never counts as income there.
- **Notes and tags** go along. A tag the other ledger doesn't have is added to it.
- **Refund and payback links** are kept when both sides move together. A link to something that stays behind is let go.
- **A transfer** is no longer paired, and its other side stays where it is. The other ledger's own matching may pair the moved side again, with a withdrawal there.
- **A recurring item** stays in the ledger it's in, and the moved payment comes off it. The other ledger's recurring items can take the payment as theirs.

When a move would let go of a link, a transfer's pair or a recurring item, the app lists that and asks before it moves anything. A payment that's split between ledgers can't move until its split is undone, and a deleted transaction has to be restored first.

### Splitting a card payment

A payment onto the card arrives as one transaction, in the home. Left there, the home's balance drops by the whole payment and the other ledger's debt never goes down. **Split between ledgers…** in the payment's form gives each ledger its part: type an amount for each other ledger, and the home keeps the rest.

An example. Visa's home is Personal, and it's shared with Family:

| | Personal owes | Family owes | Visa in total |
|---|---|---|---|
| Before the payment | $200.00 | $200.00 | $400.00 |
| A $100.00 payment arrives in Personal | $100.00 | $200.00 | $300.00 |
| Split, with $80.00 for Family | $180.00 | $120.00 | $300.00 |

Personal keeps $20.00 of the payment. The total stays what the bank says, because the bank's own transaction isn't changed: Family gets a transaction of +$80.00 ("Share of a Personal payment"), and Personal gets one of −$80.00 for what it gave, shown under the payment as "Shares for Family". The payment has a **Split** mark, and the All ledgers list shows it once, with its shares.

- Each ledger counts its share as a card payment, not as spending or income. So every ledger in the split needs a category for card payments.
- Only a card payment can be split: money onto the card that's a transfer, or in a category left out of totals, with no refund or payback link.
- **Change the split…** opens it again, and **Undo split** gives the whole payment back to the ledger that holds it.
- While it's split, the payment's date, account and payee can't be changed by hand and it can't be deleted or moved. The share rows are changed through the split, not on their own. Notes, tags and names can still change.
- A payment held by a ledger that isn't the home (it was moved there) splits the same way: that ledger types what it keeps and what the others get, and the home gets the rest.
- When the bank changes the payment's date or pending status, the shares follow. When it changes the amount, the shares stay as typed and the ledger that holds the payment takes the difference. If the shares are then more than the payment, it says so. When the bank removes the payment, the split is undone first.

### A ledger that isn't the home

A ledger the card is shared with can do everything with the transactions it holds: add them by hand, edit, delete and restore them, move them to another ledger, and split a payment it holds. In **Edit account** it chooses the institution the card sits under, and it can reorder and archive the card for itself.

It can't change the card's name, type, starting balance or notes, update its balance, import a CSV into it, link or sync it, share it or delete it. Those are done in the home, and the app says which ledger that is.

One thing to know. The bank's balance (or the last one you recorded with **Update balance**) is the whole account's, and one ledger carries the card's starting balance: the home, or the ledger that was the home before you changed it. That ledger takes up any difference between the transactions and the bank. So when another ledger deletes a synced transaction, changes its amount, or adds one by hand that the bank never has, the total stays the bank's and the difference shows in that ledger's balance. The app says so where it can happen: "Visa is a shared account, so Personal’s balance on it may change."

**Update balance** on a shared card that isn't synced records the whole account's balance, and shows what it gives each ledger before you save.

### Changing the home

In **Share with…**, pick another ledger as the **Home**. Nothing already recorded moves and no balance changes, on any date. From then on new transactions from sync and CSV land in the new home, and the bank link, the recorded balances, the CSV column mapping and the account's settings are there.

The starting balance stays with the ledger that had it, which keeps taking up differences with the bank. The dialog says so before you save: "Family is the home from now on. Personal keeps Visa’s opening balance, and differences with the bank still land in Personal."

### Stop sharing

Untick a ledger in **Share with…**. The home can't be unticked: make another ledger the home first. A ledger with no transactions on the card just loses it. One that holds some asks what happens to them, and each choice shows the balances it gives before you save:

- **Move them to the home** ("Move Family’s 12 transactions to Personal"). They become the home's transactions, as with any move. The home's balance on the card grows by what Family owed, and the total doesn't change. Family's share of a payment the home holds goes back to the home.
- **Keep them** ("Keep them in Family, in a new manual account"). Family gets a new credit card account of its own, with the same name, holding those transactions. Its balance is what Family owed. It isn't synced, and the bank never adds those transactions to the shared card again. Family's recurring items, custom reports and report filters that named the card name the new account.

  With "keep", the card's total doesn't go down. It's still what the bank says, and Family no longer has a part of it. So what Family owed is counted twice: on Family's new account, and inside the balance of the ledger that carries the card's starting balance. It stays that way until you record how it was settled, by hand, for example with a payment on Family's new account once Family has paid its part. The dialog names the ledger and the amount.

  Pending transactions from the bank go to the home even with "keep", because the bank will post them again under the card. Splits that Family was part of end, and each share becomes an ordinary transaction where it is, with no balance changing.

With only the home left ticked, the card isn't shared any more. A shared card can't be deleted: stop sharing it first.

### Deleting, erasing or archiving a ledger

A ledger that has a shared card asks first, in the same dialog:

- **"Visa’s home is Personal. Which ledger becomes its home?"** when the ledger is the card's home. This is asked before archiving too: an archived ledger is never a home.
- **"Personal has 42 transactions on Visa. Delete them or move them?"** before deleting or erasing, with **Delete them** and **Move to Family**. Under the choices it says what each does to the other ledgers' balances, now and at the next sync.
- When the ledger carries the card's starting balance, a note says it goes to the home, and by how much the home's balance changes.

Once everything is answered, **Once it’s done** lists what else will have changed, and the toast repeats it afterwards. When the ledger is the home and every other ledger that has the card is archived, it can't be done: restore one of them, or stop sharing the card, first.

Deleted transactions that came from the bank aren't forgotten: the card remembers them, so a sync doesn't add them again in the home.

An archived ledger keeps its transactions and its balance on the card, and syncs still update them. It can't become the home, be given another card, or take moved transactions until it's restored.

### Left out for now

- Other account types. Only credit cards can be shared, and a shared card can't change type.
- Suggestions to move a transaction. You decide what belongs where.
- A backup of one ledger. The full backup holds every ledger, shared accounts included.
