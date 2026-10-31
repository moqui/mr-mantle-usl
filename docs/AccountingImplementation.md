# Accounting native implementation

P1 establishes `AccountingPolicy`, permission-derived capabilities, organization/record checks, scoped queries,
draft document creation, draft journal headers, search documents and read-only setup health. The additive model
contains the locks, dimensions, previews, templates, content and audit fields needed by P2/P3; adoption flags default
to N. No new service references BOSS. Existing financial mutation authorization remains unchanged.

P2 adds the opt-in choke-point guard, typed locks and named exceptions, read-only verification, reviewed
fingerprints and PostingOperation identities, dated reversal and forward issuance deltas. Journal batches use
one transaction per constituent for validation and posting. Templates publish immutable versions and instantiate
unposted drafts. Account assignment dates, required dimensions and scoped journal content are enforced natively.
Reports keep currencies separate and read stored closed-period summaries or live open-period postings.

P3 adds SetupServices configuration validation and conflict-preview cloning, due-only terms, manual dated
CurrencyServices rates and CSV import outcomes, and payment method metadata/masking. PaymentGatewayOrganization
is provisioned outside finance forms; active organization bindings constrain new method gateway choices. The
configuration forms never receive credentials or executable service names. Posted accounting basis and issued
identities are preserved. Generic missing invoice-item defaults are checked using the native invoice resolver;
product and category mappings retain its established precedence.

AccountingControls uses spec-local permission groups and covers authorization with artifact checks disabled,
read-only verification, stale previews, concurrent retries, changed-key reuse, lock scopes/expiry/hard boundaries,
closed parents, required dimensions, rollback, reversals, partial batches, immutable templates, attachments,
cloning conflicts, dated rates/CSV failures, masking, gateway bindings and mapping repair. AccountingReports checks
separate currencies, comparison calculations and stored closed summaries. The original ledger baseline remains
18/18 passing. Final full results are recorded in mr-boss/docs/AccountingImplementation.md, including the four
unchanged baseline failures. Revaluation and Projects billing regressions execute with the installed Chrome PDF
renderer. No Node test dependency or BOSS group/service reference was added to a native service, data file or spec.

Final integration: 863 standalone features, 842 passed, four pre-existing failures and 17 skipped. The unchanged
b48e696c baseline reproduces InboxThreads, MantleSearch, WorkTimeEntries and WorkTimesheets. The focused native
controls/reports, original ledger baseline, Products standard costs/revaluation and Projects billing pass 82/82.
Journal/template/payment writers round to the selected currency; clone previews identify destination-incompatible
mappings without blocking independent compatible rows.

Authorized invoice/bill reads compute totals through the existing read-only InvoiceServices.get#InvoiceTotal when
stored totals are absent. The parent record's permission and organization checks precede the child calculation.

Document projections include public or actor-owned counterparty names after the parent record is authorized;
other users' private names are omitted even when artifact authorization is disabled.

## Receivables (P4)

P4 and P5 use Mantle's existing services and extend them with parameters; the review R2 in mr-boss's
`plan/impl-accounting.md` removed what P4–P5 first built beside them.

- **State.** `InvoiceServices.change#InvoiceState` is the guarded status change over Mantle's status flow: finalize
  or approve, resume, cancel, receive and sent. It checks the side's edit permission (`INVOICE_APPROVE` to approve),
  the revision (`lastUpdatedStamp`), the period and accounting locks, the single-currency and approval preferences
  and that the posting is done. Drafts are edited through `create#Receivable`, `store#InvoiceDraft`,
  `store#InvoiceDraftItem` and `delete#InvoiceDraftItem`; `reverse#DraftInvoice` calls `reverse#Invoice`.
- **Reads.** `find#Receivables`, `get#ReceivableSummary` and `get#InvoiceFinanceDetail` read the stored
  `invoiceTotal` and `unpaidTotal`, and leave out parties another user keeps private.
- **Print and send.** `get#InvoiceOutput` renders `template/account/Invoice.print.html.fancy` over
  `get#InvoicePrintInfo`, or the template a store or party setting names; Mantle never takes HTML from its caller.
  `send#Invoice` finalizes a draft, freezes the print as an immutable PDF `InvoiceContent` with copies of the
  supporting files the sender chose by version (`get#InvoiceDeliveryAttachments`), and sends through
  `send#EmailTemplate` (`MANTLE_INVOICE_EMAIL`, body `InvoiceEmail.html.fancy`); the messages are recorded in
  `InvoiceEmailMessage`. A caller with its own print names it with `printLocation` (Projects, for its time detail).
  The `IssuedInvoiceContentImmutable` EECA keeps issued files as sent, and the `InvoiceFinalizedSendEmail` SECA skips
  an invoice `send#Invoice` issued. `process#InvoiceBatch` sends, finalizes or prints each selected invoice in its own
  transaction; `get#InvoiceBatchResult` reads the result.
- **Credits.** `create#InvoiceCreditMemo` with `linkToOriginal` makes a credit linked to its original
  (`Invoice.creditForInvoiceId`), within the original's total, optionally split over its lines (`allocateToLines`);
  `apply#InvoiceCredit` applies it through `apply#InvoiceToInvoice`.
- **Approved time.** `find#ApprovedTimeBilling` and `create#InvoiceFromApprovedTime` bill a project's approved time
  and worker expenses at their billing rates (`ApprovedTimeBilling.js`).
- **Statements.** `CollectionServices.get#Statements` gives one statement per customer and currency over
  `get#ReceivableStatementInfo`: today's open items with their aging as of a date, printed by
  `template/account/ReceivableStatement.print.html.fancy`. There is no opening balance and no stored snapshot.
  `send#Statements` sends each as a PDF through `MANTLE_STATEMENT_EMAIL`, each address in its own transaction.
- **Customer.** `CustomerFinanceServices.get#CustomerFinance` reads contacts, the billing addresses (`sendTo`),
  orders, receivables, payments, agreements and aging through the existing services; masked payment methods only for
  treasury. `store#CustomerIdentification`, `store#CustomerBankAccount` and `store#CustomerTaxRegistration` write the
  finance details.
- **Book day.** `create#Invoice` records the invoice's book day (`Invoice.accountingDate`) and drafter, both audited.

## Payments and settlement (P5)

**Reviews.** A change the user reviews and then confirms is a `PaymentReview` row: its kind (`previewKindEnumId`,
the `PaymentReviewKind` enumeration: settlement, automatic application, settlement draft, state change,
unapplication, gateway action, refund, internal transfer), its status (`PrvDraft`, `PrvReview`, `PrvComplete`), its
user, organization and payment, the fingerprint confirming must match, the request, what the user reviewed and the
result. `store#PaymentReview` keeps it, `get#PaymentReview` reads the user's own, `claim#PaymentReview` begins
confirming with an operation key and `complete#PaymentReview` records the result. A confirmation with the same key and
fingerprint returns the first result; another fingerprint under the key is refused. A payment's version is its
`lastUpdatedStamp`. Each `preview#` service changes no financial record.

**Settlement.** `find#OpenItems` finds a counterparty's open invoices, credits and payments in one currency, a page
for each kind, from the SQL views `SettlementInvoiceBalance` and `SettlementPaymentBalance`.
`find#SettlementAdjustmentAccounts` offers the accounts assigned to the organization chain on the date.
`preview#Settlement`, `get#SettlementPreview` and `apply#Settlement` review and confirm allocations, and discounts or
write-offs (`ItemPromptDiscount`, `ItemWriteOff`) on an explicit account. Confirming applies each allocation through
`apply#InvoicePayment`, `apply#PaymentToPayment` or `apply#InvoiceToInvoice` on the reviewed `appliedDate` and
`accountingDate`, and each adjustment as a credit memo from `create#InvoiceCreditMemo` applied to its invoice.
`store#SettlementDraft` and `get#SettlementDraft` keep the user's selection behind an id for a day.
`preview#PaymentAutoApplication` and `autoApply#Payment` apply a payment to the oldest due invoices.

The `apply#*` services lock the organization and both documents, and refuse for every caller an application dated
before a document's posting, an internal transfer, a gateway authorization or held gateway cash, and an amount finer
than the currency. `unapply#PaymentApplication` refuses the application that funds a completed refund, and leaves
`Invoice.paidDate` as it was. `PostingGuard`, inside `post#AcctgTrans` and the apply and unapply services, checks the
periods, locks, source postings and accounts.

**Payments.** `find#Payments` lists the organization's payments by queue (incoming, outgoing, to validate,
unapplied, refunds, transfers, all) with their application balances; the unapplied queue leaves out transfers.
`get#PaymentFinanceDetail` reads one payment: masked methods, applications, refunds, documents, files and history,
and ledger and gateway rows with their read authority. `get#PaymentAccess` answers what a user may do with its files.
`create#PaymentDraft` and `store#PaymentDraft` write a proposed receipt or disbursement through `create#`/`update#Payment`;
their tx-commit SECAs send a PaymentValidation notice (`send#PaymentValidationNotice`), which
`approve#PaymentValidationNotice` and `refuse#PaymentValidationNotice` answer. `preview#PaymentState`,
`get#PaymentStatePreview` and `change#PaymentState` validate, deliver, confirm, cancel or void through `update#Payment`
along `StatusFlowTransition`, so the Payment SECAs post, void, unapply and clear. `preview#PaymentUnapply`,
`get#PaymentUnapplyPreview` and `unapply#ReviewedPayment` unapply chosen applications through
`unapply#PaymentApplication`. `revert#PaymentPost` and `revert#PaymentApplicationPost` take a `reversalDate`.
`PaymentLifecycleEvent` keeps each change's reference and reason for History.

**Documents.** `issue#PaymentDocuments` issues a delivered payment's receipt (`PctReceipt`), detail
(`PctPaymentDocument`) and, with a check number, check (`PctCheckImage`), each a PDF of
`template/account/PaymentDocument.html.fancy` under `mantle.content.large.root`; a transfer gets its detail only.
`get#PaymentDocumentInfo` gives the template's values and `get#PaymentOutput` reads an issued document; a check needs
treasury authority. `save#PaymentContentFile` refuses to replace a file once the payment is posted.

**Gateway.** `authorize#`, `capture#`, `release#` and `refund#SinglePayment` take an optional `operationKey`, lock the
payment, and answer a retry with the first `PaymentGatewayResponse` without calling the gateway; the response records
the key and the refund payment (`operationKey`, `refundPaymentId`). `get#PaymentGatewayActions` finds the payment's
gateway as those services do and the actions the user may review. `preview#PaymentGatewayAction`,
`get#PaymentGatewayActionPreview` and `execute#PaymentGatewayAction` review and run them; a refund is a promised
`create#RefundPayment` and `refund#SinglePayment` for it. An accepted capture delivers and posts; an accepted refund is
delivered and applied to its original (`apply#RefundPayment`); a declined one is `PmntDeclined`; a pending one stays
promised until `lookup#PaymentGatewayDetails` (over `get#SinglePaymentGatewayDetails`) finds the gateway's answer.
`find#PaymentGatewayTransactions` and `find#PaymentGatewayProviders` search the responses. Real gateways (Braintree,
PayTrace, Authorize.Net) implement the same interfaces. There is no partial capture.

**Refunds.** `create#RefundPayment` takes an `accountingDate` and refuses more than the original less its other
refunds, pending ones included. `get#PaymentRefundSummary` gives what is left to refund, and `get#PaymentRefundPlan`,
`preview#PaymentRefund`, `get#PaymentRefundPreview` and `refund#ReviewedPayment` review and confirm a manual refund
through it, so the Payment SECAs post it and it is applied to the original.

**Transfers.** `get#InternalTransferPlan` checks a transfer and plans its payments and postings;
`preview#InternalTransfer`, `get#InternalTransferPreview` and `create#InternalTransfer` review and confirm it, with
`find#InternalTransferMethods` and `find#InternalTransferFeeAccounts` for the choices. A transfer is one delivered
`PtInternalTransfer` payment from the organization to itself, `paymentMethodId` the from method and
`toPaymentMethodId` the to method, through `create#Payment`. Its `PaymentGlPost` SECA runs `post#Payment`, which posts
the outgoing and incoming transactions through the `PtInternalTransfer` transit `PaymentTypeGlAccount` (258300000 by
default); `get#PaymentMethodGlAccount` takes `isPayable` so each side finds its own method's cash account. A fee is
its own `PtDisbursement` payment to an outside party, by default the from bank's party, posted to the chosen expense
account (`Payment.overrideTypeGlAccountId`), and points at its transfer (`Payment.feeForPaymentId`). One service
transaction holds them all, so they post together or not at all.

## Payables (P6)

**Supplier profile.** `mantle.party.supplier.SupplierProfile` keeps an organization's profile of a supplier as
effective-dated rows with audit-logged fields: the default payment term of its bills (`settlementTermId`) and
self-billing (`selfBillingIndicator`). `mantle.party.SupplierServices.store#SupplierProfile` ends the row in effect and
starts the next (`SUPPLIER_TERMS_EDIT` for these finance fields; Purchasing adds the buyer fields under
`SUPPLIER_PROFILE_EDIT`); `get#SupplierFinance` reads a supplier's bills, payments, open, in-review, held and overdue
amounts, agreements, profile rows and, by permission, its masked bank accounts, identifications and tax
registrations. The `CustomerFinanceServices` writers take `side`: `check#CustomerScope` counts only that side's
relationship (a customer's sales or current relationship; a supplier's bills, purchase orders or profile), and a
supplier's identifications need `PAYABLE_EDIT`.

**Due date.** `checkSet#InvoiceDueDate` (the `InvoiceSetDueDate` EECA): the invoice's term, else the newest agreement
term, else for a bill the supplier's term in effect on the invoice date, else for a receivable the organization's.

**Intake and approval.** `mantle.account.InvoiceServices` (logic in `account/Payables.js`):
- `find#Payables`: a page of an organization's bills by queue (incoming, review, held, approved, due, credits, a
  person's expenses, all), each with its open holds (`PAYABLE_VIEW` or `ACCOUNTING_VIEW`).
- `import#Bill` (`PAYABLE_IMPORT`): a draft bill keyed by organization, supplier and the supplier's reference, one line
  for an amount given and the file as its content; a repeat is refused (`BILL_DUPLICATE`) naming the first. For a
  receipt (`shipmentId`) billed as a draft without a reference (self-billed), the file is attached to that draft, which
  takes the reference; a later upload for the receipt, or one whose bill is no longer a draft, is refused naming it.
- `create#InvoiceFromSource` (`PAYABLE_EDIT` for a purchase, `RECEIVABLE_EDIT` for a sale): the ordered basis
  (`create#EntireOrderPartInvoice`) or, for a purchase, the received basis (`create#PurchaseShipmentInvoices` with
  `acceptedOnly`), each delivered receipt once; the order's payments are marked for the invoice and apply when it is
  approved; a source already invoiced is refused (`SOURCE_ALREADY_INVOICED`); a retried operation key answers first.
- `request#PayableApproval` (`PAYABLE_EDIT`): an incoming bill is received and `BillApproval` sent to the
  organization's users who hold `INVOICE_APPROVE`.
- `approve#Payable` (`INVOICE_APPROVE`): a bill's posting day when given, then `change#InvoiceState`'s approval; the
  bill's `BillApproval` notifications are marked read.

**Holds.** `mantle.account.invoice.InvoiceHold`, reasons of enumeration type `InvoiceHoldReason` (match exception, AP
review, supplier dispute, bank detail change). `hold#Invoice` (`INVOICE_HOLD`; a payable only, one open hold per
reason), `request#HoldRelease` (`PAYABLE_EDIT`; records the request and sends `BillHoldRelease` to the organization's users who
hold `INVOICE_HOLD_RELEASE`), `release#InvoiceHold` (`INVOICE_HOLD_RELEASE`; never by the placer, `HOLD_RELEASE_SELF`,
with a reason; marks the hold's notifications read and, for the last hold of an approved bill, applies its waiting
payments) and `get#InvoiceHolds`. The hold
guard, `InvoiceWorkflowLib.requireNotHeld` (`INVOICE_HELD`), runs in `change#InvoiceState`'s approval of a bill, in the
rules every application checks (`PaymentSettlement.checkApplication`, so `apply#InvoicePayment`,
`apply#InvoiceToInvoice` and `apply#Settlement`), in `create#InvoicePayment`, and in the open items
(`find#OpenItems` gives a held bill the reason `INVOICE_HELD`; `InvoiceFinance.heldInvoiceId` is a sub-select of the
open holds). `apply#PaymentForInvoice` and `apply#InvoiceForPayments`,
which the `PaymentApplyForInvoice` and `InvoiceApplyForPayments` SECAs call, leave a held bill's payments unapplied
with a `PAYMENT_HELD` warning. There is no flag: no flow spec holds a bill.

**Receipt billing (D2).** `create#PurchaseShipmentInvoices` and `create#SalesShipmentInvoices` take `acceptedOnly`: a
receipt's accepted quantity only, no leftover line and no charge or service line. With
`PartyAcctgPreference.receiptInvoiceSelfBilledOnly` Y (off by default; a preference `store#Preferences` sets),
`ShipmentIncomingDeliveredCreateInvoices`
bills a delivered receipt only for a supplier whose profile in effect is self-billing, and then with `acceptedOnly`;
otherwise the bill comes from the supplier or the order. A receipt with nothing accepted leaves no empty bill. OrderProcureToPayBasicFlow asserts the SECA's bill with its
freight line, so the rule is a flag; BOSS's demo organization turns it on.

**Cost centers (AC-22).** `OrderItem.costCenterId` and `InvoiceItem.costCenterId`: a bill or invoice line made from an
order line takes its cost center, and the invoice postings (`post#Invoice`, `post#InvoiceAdjustment`) carry the line's.

## Matching (P7)

**Policy.** `mantle.account.invoice.InvoiceMatchPolicy`: an organization's match policy as effective-dated rows with
audit-logged fields, for the organization (no product and no category), a product category or a product; a product row
wins over a category row, which wins over the organization's. A row has the bill basis (`ImbReceived`, accepted receipts,
three-way; `ImbOrdered`, two-way), receipt required on the ordered basis, a quantity and a price tolerance (each the
larger of a percent and a fixed allowance), the variance action (`ImaHold`, `ImaWarn`) and the self-billing default that a
supplier's first `SupplierProfile` row takes. With no row in effect: received basis, no tolerance, hold.
`InvoiceMatchServices.store#MatchPolicy` (`ACCOUNTING_ADMIN`) ends the row in effect for the scope and starts the next
(`POLICY_OVERLAP` before a later row), `end#MatchPolicy` ends a category or product row, `get#MatchPolicies` reads them.

**Match.** `mantle.account.invoice.InvoiceMatch` (one applied, `ImApplied`, per bill; `ImUnapplied` when undone) and
`InvoiceMatchLine`: each allocation of a bill line to an order line, and on the received basis to one receipt, with its
snapshot (bill and order quantity and price, accepted, held and earlier billed quantity), the policy row it applied, its
exception, and the billing link it wrote with that link's quantity before. Logic in `account/InvoiceMatch.js`:
- `evaluate#InvoiceMatch` (`INVOICE_MATCH`, `PAYABLE_VIEW` or `ACCOUNTING_VIEW`), read only: an applied match checked
  against its sources now, else the allocations given or the proposal (the line's billing links, else the approved order
  lines of the product from the supplier, oldest first, on the policy's basis).
- `apply#InvoiceMatch` (`INVOICE_MATCH`): the allocations checked again under lock (organization, bill, order lines in
  order) and refused when the source does not allow them (`SOURCE_INVALID`, also for an order in another currency;
  `ALREADY_BILLED`, `MISSING_RECEIPT`, `QUANTITY_EXCESS`). Other bills' billing, this bill's earlier allocations (a
  running total per order line and per receipt) and the allocation together may not pass the source's base (accepted
  less held, or ordered) plus the tolerance, the larger of the policy's percent of the base and its fixed quantity. It
  writes or updates `OrderItemBilling`; a receipt with no invoice gets the bill line once links with a quantity cover its
  accepted quantity, as `apply#InvoiceItemToOrder` does. An exception that holds by its policy (price outside tolerance,
  quantity not matched, no source, no receipt where required) places the `IhrMatchException` hold naming the rule,
  through `InvoiceWorkflowLib.placeHold`, the hold creation `hold#Invoice` uses after its own `INVOICE_HOLD` check: a
  match operator need not hold `INVOICE_HOLD`, and an approver who did not apply the match releases it with
  `release#InvoiceHold`. Each line keeps every exception code (`exceptionCodes`). A retried operation key answers first.
- `unapply#InvoiceMatch` (`INVOICE_MATCH`): links back to their quantity before (zero when the match made them); a
  receipt that names the bill names another bill still linked to it, or none; the hold stays.
- Quantity in quarantine (an accepted receipt whose asset is `AstQuarantine`) is held and left out (D21). There is no
  inspection record yet (CX-QUALITY), so the inspection check is reported unavailable, never passed (F50). Service lines
  are not matched until Purchasing's acceptance exists.

**Re-evaluation.** The `AssetReceiptQueueMatchReevaluation` EECA (a receipt created or removed, or its accepted
quantity, order line or asset changed; not a write of its invoice) and `InvoiceItemQueueMatchReevaluation` call
`queue#MatchReevaluation`, which reads the match lines by index and marks the applied matches of the receipt, order line
or bill stale. The `run_MatchReevaluation` job (`run#MatchReevaluation`, every five minutes) evaluates each stale match in
its own transaction (`reevaluate#InvoiceMatch`, the bill locked before the match) with the policy rows its lines applied
and names each bill's result. It holds a bill whose source no longer allows its match (`MeSourceChanged`), or for an
exception that holds and that the match's lines did not record, and records it; a legacy match only for a source change.
A failure is recorded on the match and its stale date moved to now, so the others go first. No hold is released by the
match or the job.

**Legacy backfill.** `preview#LegacyMatches` and `apply#LegacyMatches` (`INVOICE_MATCH`): the organization's bills with no
applied match, linked only from unambiguous evidence: a line's billing links, else its receipts on one order line. Links
or receipts of another party, product or several order lines are ambiguous and recorded as `MeAmbiguous` exception lines;
a line with no evidence is not linked, and what the evidence does not explain stays unmatched; the match is partly matched
then, an exception for an ambiguous line, and each line keeps the policy row in effect. Bills are read in invoice order a
batch at a time with the matched ones left out (`afterInvoiceId`; the preview answers `lastInvoiceId`). Each bill runs
in its own transaction (`apply#LegacyMatch`); a failure is named and the others go on. No hold is placed.

## Banking (P9)

`ReconciliationServices` holds the bank side, on the existing bank lines (`PaymentMethodTrans`): a statement session
links them, it does not copy them. Each new service checks the bank account's organization and the user's authority
through `check#BankAccess`: reading bank lines needs `BANK_RECONCILE`, `ACCOUNTING_VIEW` or administration, changing
them `BANK_RECONCILE`, and a deposit `PAYMENT_EDIT` with `PAYMENT_VIEW`. Callers of the older services
(`create#`/`update#`/`reconcile#`/`unreconcile#`/`noReconcile#PaymentMethodTrans`, `match#PaymentMethodTransUnmatched`)
check `check#BankAccess` first; those services keep running for the statement message consumers.

- **Line identity.** A bank line's key (`fitId`) is the bank's FIT id in OFX, and a source-row key in BAI2 and CSV
  (a hash of the row and its occurrence in the file), so a file imported again adds nothing (F33).
  `account/BankReconciliation.js` reads the three formats; `import#BaiVersion2` and `import#OfxVersion1` use it and
  skip known lines.
- **Statement import.** `preview#CsvStatement` shows a CSV with its column mapping. `review#StatementImport` keeps a
  `StatementImport` with each row new, a duplicate or rejected with its error, and refuses a file of another account;
  `get#StatementImport` reads it and `commit#StatementImport` creates the new lines, each in its own transaction, and
  updates the statement balance. A second commit answers the first.
- **Matching.** `find#BankLines` pages a bank's lines (or the organization's open ones) with their state, the session
  that cleared each and, on request, a suggestion. `find#BankLineCandidates` lists the payments, deposits and ledger
  entries of the same bank, direction and amount near the line's date, and `reconcile#BankLine` reconciles one of them
  through `reconcile#PaymentMethodTrans`. `match#PaymentMethodTransUnmatched` now reconciles only a line with one
  possible match. `reconcile#`, `unreconcile#` and `noReconcile#PaymentMethodTrans` refuse a line a finished session
  cleared (`check#BankLineOpen`); `noReconcile#` records its reason (`noReconcileReason`).
- **Rules.** `BankMatchRule` matches a line's text, direction and amount and suggests a party's payments.
  `store#Rule` adds, changes or ends one (audit-logged fields); `test#Rule` previews a stored or draft rule on the open
  lines; `apply#Rules` reconciles only a line one auto-apply rule matches alone with exactly one payment.
- **Sessions.** `create#Reconciliation` starts a `BankReconciliation` for a period that overlaps no other session of
  the bank, opening at the last finished closing balance. `store#Reconciliation` changes its reference and closing
  balance and clears or unclears lines (`BankReconciliationLine`, keyed by the line, so one session clears a line);
  a cleared line is in the period and matched, or excluded with a reason. `finish#Reconciliation` needs every line
  of the period cleared and a zero difference; `get#Reconciliation` gives the figures.
- **Controls.** `reconcile#BankLine` takes, under the line's lock, only a candidate of an open line; a payment on a
  finished statement's line stays there. A payment two lines match goes to neither (`apply#Rules`,
  `match#PaymentMethodTransUnmatched`). Statements follow one another, each starting the day after the previous one
  once it is finished; no line is added, imported or moved into a finished period (`check#BankLineDay`).
- **Stored value.** `FinancialAccountServices.record#FinancialAccountMovement` is a finance user's own deposit,
  withdrawal or adjustment, refused when its transaction does not post; the movement services orders and payments call
  keep their automatic posting.
- **Deposits.** `PaymentServices.find#DepositReceipts` and `create#DepositSlip` group delivered receipts into this bank
  account into one `PaymentDeposit` (`Payment.paymentDepositId`, under an operation key). The deposit's one bank line
  reconciles them all (`PaymentMethodTrans.paymentDepositId`), and a second line for it is refused.

## Tax (P14)

`mantle.other.TaxServices` with `other/SalesTax.js` (the calculation) and `other/TaxStatements.js` (statements). The
first release has local sales tax and the US 1099 data.

- **Rates.** `TaxAuthorityRate` is active, keyed to `TaxAuthority` by `taxAuthorityId`: a dated row per version, with
  the rate type (`TarSalesTax`), the collecting organization, an optional store and product category, minimums and
  whether shipping is taxed. `store#Rate` (`ACCOUNTING_ADMIN`) starts a rate, a new version of one (ending the one it
  replaces) or its end, and refuses an overlap of the same authority, type and scope. `store#Authority`
  (`ACCOUNTING_ADMIN`) writes the authority with the organization's tax account (`TaxAuthorityGlAccount`) and nexus and
  registration (`TaxAuthorityParty.isNexus`, `partyTaxId`); a change of these ends the row in effect and starts a new
  one. An authority, and a rate for every organization, are shared: only a system administrator changes them
  (`AUTHORITY_SHARED`, `RATE_SHARED`). The organization's gateway is a preference (`store#Preferences`).
- **Calculation.** `calculate#SalesTaxLocal`, the `LOCAL` gateway, taxes an item for each authority whose geo is one of
  the destination's (else the origin's), where the organization (or one it rolls up to) has nexus, at the most specific
  rate in effect on the tax date (category, then store, then organization). A discount of the whole sale is spread over
  the taxed lines in proportion to their bases. A product line is taxable unless
  it or its product says not; another line only when `taxableFlag` is Y; shipping when the rate says so. A customer
  exempt in the authority (`TaxAuthorityParty.isExempt`) gets an explicit zero with its reason. It refuses a taxed sale
  without a destination (`TAX_ADDRESS_MISSING`), an authority with nexus and no rate in effect (`TAX_RATE_MISSING`)
  and two rates of one scope (`TAX_RATE_AMBIGUOUS`). An organization with no sales tax nexus gets no results, so
  Mantle's order flows are as before. The `calculate#SalesTax` interface gained the store, tax date, currency,
  destination geos and an item's `taxableFlag`, and its results the rate version, base, rate, unrounded tax, rounding
  and exemption.
- **Invoices.** `calculate#InvoiceSalesTax` writes a draft sales invoice's `ItemSalesTax` lines under the taxed items
  through its store's gateway, else the organization's (`PartyAcctgPreference.taxGatewayConfigId`), each with its
  authority, rate version (`InvoiceItem.taxAuthorityRateId`), base (`taxableAmount`), rate (`taxPercentage`) and
  rounding (`taxRoundingAmount`), marked `taxCalculated`; the same results leave the lines as they are. It skips an invoice billed from orders,
  whose tax came with the order. `change#InvoiceState` runs it before a sales invoice is finalized or approved, so a
  tax refusal refuses the change, and removes the calculated lines when an invoice goes back to draft. A tax line
  posts to the organization's account for its authority (`get#InvoiceItemGlAccount` with `taxAuthorityId`), else the
  item type's.
- **Statements.** `find#SalesTaxLines` reads an authority's tax lines on the organization's issued sales invoices
  dated in a period; `create#SalesTaxStatement` (`TAX_STATEMENT_EDIT`) makes a `TaxStatement` on the
  `LocalSalesTaxReturn` form with the taxable sales, tax and line count. `run#Vendor1099Statements`
  (`TAX_STATEMENT_EDIT`) makes the 1099-MISC data of a year for each vendor the organization paid who is registered
  with the authority and not exempt, from the year's payments applied to the vendor's invoices
  (`create#Vendor1099MiscStatement` with `itemTypeTotals`); a vendor without a taxpayer number or address, or with a
  statement for the year, is named with its reason. `export#Statement` (`TAX_STATEMENT_EDIT`) gives the CSV data with
  its format version and records the export; a sales tax statement whose invoices changed since is refused, and an
  exported statement is not deleted (`delete#TaxStatement`). `simulate#SalesTax` explains a sample sale.

## Returns and order changes (P17)

**Flags.** Two audit-logged `PartyAcctgPreference` fields (`entity/ReturnSettlementEntities.xml`), off by default and set
through `store#Preferences`, since Mantle's ReturnToResponse and OrderToCash flows assert the old behavior:
- `returnSettlementRequired` (D11): `ReturnApprovedProcess` only creates the return shipment, `ShipmentDeliveredReturnReceive`
  and `ReturnReceivedProcess` stand aside, and responses come only from `settle#Return`. `ReturnServices.get#ReturnSettlementMode`
  answers whose return it is (the vendor of a customer return, the customer of a supplier return) and the flag.
- `salesInvoiceFinalizedAtShip` (D3): `ShipmentOutgoingPackedCreateInvoices` leaves the sales invoice in process with no
  payment applied, and `ShipmentShippedFinalizeInvoices` (shipped, or delivered unshipped) calls
  `InvoiceServices.finalize#ShipmentInvoices`, which finalizes it and applies the order part's payments, as the pack did.

**Receipt.** `WarehouseTaskServices.receive#ReturnItems` (`STOCK_RECEIVE`, Warehouse's contract): per return item on a
customer return shipment, the accepted units as stock (`receive#Asset` on the item's source) and the rejected units as a
receipt with no stock; `ReturnItem.receivedQuantity` grows, `returnQuantity` never changes, no response is processed.
The item reaches ReturnReceived (ReturnManResp for a manual response) when all its authorized quantity arrived, the return
when every item is handled, the shipment ShipDelivered when every source is. It refuses more than authorized
(`RECEIPT_EXCEEDS_RETURN`) and an organization without `returnSettlementRequired` (`RETURN_SETTLEMENT_OFF`).

**Settlement.** `ReturnServices.preview#ReturnSettlement` and `settle#Return` (logic in `order/ReturnSettlement.js`):
- Eligibility: a customer item what was received (authorized, for a receiptless credit) less what its standing billing links
  settled, within what its order line billed less what every return credited; a supplier item what was shipped back
  (ReturnShipped or later) within what was billed less earlier supplier credits. An item's discount and tax children follow
  it, prorated by the quantity settled.
- The preview answers each item's quantities, the lines of the request with their amounts, the credit, refund and
  replacement totals, the original payment a refund goes to, its `previewVersion` and the first refusal it would meet
  (`reasonCode`). A reader (the side's view or edit permission, or `ACCOUNTING_VIEW`) previews.
- `settle#Return` checks the writer's permission first (`FORBIDDEN`: a customer return needs `RECEIVABLE_EDIT`, a refund
  also `PAYMENT_EDIT`, a receiptless credit also `RETURN_CREDIT_APPROVE`; a supplier return `PAYABLE_EDIT`), answers a
  retried operation key with the first result, recomputes the plan under lock (organization, return, items) and refuses
  another version (`RECEIPT_CHANGED`), more than eligible (`CREDIT_CAP_EXCEEDED`), a refund beyond the original's
  refundable amount (`CREDIT_CAP_EXCEEDED`) or while one is pending (`REFUND_PENDING`), and a closed period or lock
  (`CLOSED_PERIOD`).
- A customer return responds through `process#ReturnItemResponses` with its `settlement` parameter: the quantities given,
  each billing link with its receipt, original invoice line, receiptless flag, reason, approver, settler and operation key;
  the credit memo is the organization's receivable credit, finalized (F350); a credit is the customer credit account; a
  refund is `create#RefundPayment` against the chosen original payment for the credit memo, then `refund#SinglePayment`
  through its gateway (a pending result answers `REFUND_PENDING`) or delivered; a replacement is Mantle's replacement order.
- A supplier return makes one credit per item through `create#InvoiceCreditMemo` linked to its bill (a payable draft),
  links the billing to the bill line and the PO receipt, and queues the bill's match re-evaluation.
- An item settled for all it authorizes is completed with its children (`complete#ReturnItem`); a receiptless one first
  has its remainder closed (ReturnReceived).

**Between pack and ship.** `InvoiceServices.release#ShipmentDraftInvoice` (`RECEIVABLE_EDIT`): before the shipment ships,
the invoice lines billed for it and their billing links are removed, its sources and issuances no longer name the invoice,
and an invoice left with no line is cancelled, so packing again bills it again; a shipped shipment (`SHIPMENT_SHIPPED`) or
an invoice no longer in process (`INVOICE_FINALIZED`) is refused. `PaymentServices.refund#OrderPayment` (`PAYMENT_EDIT`)
refunds a captured order payment through `create#RefundPayment`, with the gateway's `refund#SinglePayment` when the
payment has one, within what is unapplied and not refunded (`get#PaymentRefundSummary`). Both take an operation key.

## Libraries

- `ledger/EntityLib.js`: the helpers the finance modules share: entity reads without artifact authorization (each
  module checks its permissions first), calls and probes, dates and book days (`bookDay`: the calendar day, else the
  timestamp's day in the user's zone), display values, amounts, refusals with reason codes (`denied`, `reasonCode`),
  party names that leave out private parties, paging and operation keys. Nothing in it authorizes.
- `ledger/AccountingPolicy.js`: permissions, organization scope and record checks; a refusal has a reason code.
- `ledger/PostingGuard.js`: the posting choke point. It decides an automatic posting from the transaction's source
  fields, and asks `ACCOUNTING_GL_POST` of a manual or reversal posting unless its caller passes `reviewed`.
- `account/InvoiceWorkflowLib.js`: an invoice's scope for a read or a write, and the hold guard. `Payables.js`,
  `InvoiceMatch.js`, `InvoiceWorkflow.js`,
  `InvoiceAttachments.js`, `PaymentWorkflow.js`, `PaymentLifecycle.js`, `PaymentSettlement.js`, `PaymentOutput.js`,
  `BankReconciliation.js` and `order/ReturnSettlement.js` hold the logic too involved for XML Actions; the other services
  are inline XML Actions.

## The posting guard flag

`PartyAcctgPreference.postingGuardEnabled`, off by default, gates the posting guard and the invoice and payment
`MAPPING_MISSING` refusal. Mantle's OrderToCash, ProcureToPay, ReturnToResponse, InvoicePaymentMisc and Payroll
flow specs need them off: they post with the demo account assignments, and some of their postings go to the error
journal. The other P4–P5 controls hold whatever it says. BOSS's demo organization turns it on.

## Tests

The Accounting specs make their own data, users and spec-local permission groups, and no spec depends on BOSS. The
gateway specs use the test gateway in `service/mantle/account/PaymentTestServices.xml`: `alwaysPending#` for
authorization, capture and refund, `alwaysDecline#PaymentRelease`, `alwaysDecline#PaymentRefund` and
`alwaysApprove#PaymentDetails` for a lookup that approves, named in the spec's own `PaymentGatewayConfig`.

```sh
./moq test mr-mantle
./moq test mr-mantle --spec AccountingReceivables,AccountingDelivery,AccountingCustomerFinance
./moq test mr-mantle --spec AccountingSettlement,AccountingSettlementConcurrency,AccountingApplicationRules
./moq test mr-mantle --spec AccountingPaymentLifecycle,AccountingPaymentCorrections,AccountingPaymentOutput,AccountingPaymentNotifications
./moq test mr-mantle --spec AccountingPaymentGateway,AccountingPaymentRefunds,AccountingInternalTransfers
./moq test mr-mantle --spec AccountingPayables,AccountingMatching
./moq test mr-mantle --spec AccountingBankReconciliation,BankFileServices
./moq test mr-mantle --spec AccountingTax,TaxStatementServices
./moq test mr-mantle --spec AccountingReturns,ReturnToResponseBasicFlow,OrderToCashBasicFlow
```

The PDF specs need a Chromium for PDF (`pdf_chromium_path`; see [Run-Deploy](../../../../docs/Run-Deploy.md) and
[Client-Testing](../../../../docs/dev/Client-Testing.md)); without one every PDF spec fails. The results are in
mr-boss's `plan/impl-accounting.md`.
