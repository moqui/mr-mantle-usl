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

## Payment terms and payment runs (P8)

**Payment terms.** `mantle.account.invoice.SettlementTermLine` keeps a term's portions as effective-dated rows with
audit-logged fields: the share of the total due (`portionPercent`), its days after the invoice date (`daysBasis`) and an
early-payment discount (`discountPercent` within `discountDays`). `mantle.ledger.SetupServices.store#SettlementTerm`
(`ACCOUNTING_ADMIN`) takes `lines`: portions adding up to 100, a discount ending on or before its portion is due; the
lines in effect end and the new ones start, and the term is due in its last portion's days. The seeded
`Net30Disc2Pct10` and `Net45Disc2Pct15` terms have their discount as a line. `get#Context` returns the lines in effect
(`termLines`).

**The due schedule (the contract aging, the workbenches, runs and settlement read).**
`mantle.account.invoice.InvoiceDueSchedule`, keyed by `invoiceId` and `scheduleSeqId` (`01`, `02`, ...), one row per
portion: `dueDate`, `amount` (rounded to the currency; the last portion takes what rounding leaves), `discountDate` (the
last day the discount may be taken) and `discountAmount` (empty without a discount); the dates are calendar days (type
date), the invoice's book day plus the line's days, compared day to day whatever the server's or the user's zone, with the `settlementTermId` and `settlementTermLineId` it came from. The
rows are not audit-logged: they are written once at issue and removed only on Resume Changes, both in the invoice's status
audit log, and Mantle's flow specs check the audit log's sequence.
- It is written once, when the invoice is issued: the `InvoiceIssuedDueSchedule` SECA calls `store#InvoiceDueSchedule`
  when an invoice becomes Finalized or a bill Approved. No row is written for a credit memo, an invoice without a date
  or with no total, or one that has its schedule. A term without lines in effect on the invoice date gives one row, the
  invoice's `dueDate` and total. A later term change never changes a written schedule. An issued invoice changed back
  for edits (Resume Changes) loses its schedule (`InvoiceResumedDueSchedule`, `clear#InvoiceDueSchedule`), and issuing it
  again writes the schedule of what it then is.
- `get#InvoiceDueSchedule` (a read of the invoice: its side's view permission or `ACCOUNTING_VIEW`) returns the rows with
  their day texts in the user's zone, whether each discount is open on a day (`onDate`, today by default; a discount is
  open through `discountDate`; `nextDueDate` is the next portion due on or after that day), and `discountAvailable`: the open discounts less prompt-payment
  credits already issued for the invoice (`creditForInvoiceId` with an `ItemPromptDiscount` line), at most its unpaid
  total. An invoice issued before P8, or not yet issued, gets the schedule its term gives, not stored.
- Readers in Mantle use `account/PaymentTerms.js` (`schedule`, `schedules`): `find#OpenItems` adds `discountAvailable`
  and `discountDateText` to invoice rows; payment runs select and pay by it.

**A discount taken within its date.** In `apply#Settlement` a prompt-payment discount (`ItemPromptDiscount`) with no
account, on an invoice whose schedule offers at least that amount on the accounting date, posts to the organization's
prompt-payment discount account: the `ItemPromptDiscount` item type account (`get#InvoiceItemGlAccount`), outgoing for
a customer invoice (521000000 by default), incoming for a bill (864000000). More than the schedule offers is refused
(`DISCOUNT_NOT_AVAILABLE`). Such a discount is issued by `create#InvoiceCreditMemo` with `linkToOriginal` and
`promptDiscount`: within the schedule on its date and today (the bill locked first), on the side's discount account only
(another account is `DISCOUNT_ACCOUNT_FIXED`; in a settlement it is a write-off), and within the original's credit cap, finalized as the organization's own credit with no
approval step, for the side's edit permission or `PAYMENT_EDIT`. Any other discount or write-off is P5's adjustment on an
explicit account; on a bill its credit is approved, so a user without `INVOICE_APPROVE` is refused at preview
(`ADJUSTMENT_APPROVAL_REQUIRED`). A payment run takes a bill's discount the same way (below).

**Payment runs.** `mantle.account.payment.PaymentRun` (organization, the bank account paid from, ACH or check, currency,
due-through and pay dates, status `PrunDraft` → `PrunApproved` → `PrunExecuted`, or `PrunCancelled`; the approval's
total, version and approver; the execution's operation key; the bank file) and `PaymentRunItem` (a bill, its supplier
and the supplier's bank account, due and discount dates, open, discount and payment amounts, in the run or left out with
a `PaymentRunExclusion` reason, and at execution its payment and `PaymentRunResult`). `mantle.account.PaymentRunServices`
(logic in `account/PaymentRuns.js`):
- `create#Run` and `select#Bills` (`PAYABLE_EDIT`): the organization's approved bills open in the base currency, due
  through the date or with a discount open on the pay date, at most 500. A held bill (`PrxHeld`, naming its holds), one
  in another open run (`PrxInOtherRun`) and, for ACH, one whose supplier has no current bank account
  (`PrxNoBankAccount`) are left out; a bill the user left out (`store#RunItem`, `PrxUser`) stays out. Selecting again or
  changing an item of an approved run sends it back to proposed.
- `request#RunApproval` (`PAYABLE_EDIT`): the PaymentRunApproval notification to the organization's users holding
  `PAYMENT_RUN_APPROVE`. `approve#Run` (`PAYMENT_RUN_APPROVE`): the revision, no held bill, and not the run's creator
  unless `allowAccountingSelfApproval`; it records the total and a version of the selection (bank, pay date, instrument,
  each bill's supplier account and amounts) and marks the notifications read.
- `execute#Run` (`PAYMENT_EDIT`, an operation key): a completed execution under the key is answered first from its
  `PostingOperation` (type `PaymentRunExecute`); another key is refused while the run's claim (`executeOperationKey`)
  holds it, and the same key resumes an execution that stopped. A pay date in the past is refused. `claim#RunExecution`
  checks the approved version in its own transaction. Each supplier is then paid in its own transaction
  (`pay#RunSupplier`, the run locked first, so a supplier is never paid twice): its bills locked, holds, approval, open
  amounts, discounts and the supplier's bank account read again; one payment through `create#Payment`
  (`PtInvoicePayment`) is the supplier's instruction identity. The run is executed only when every payment it made is
  applied; otherwise it stays approved with `executionMessage`, and `get#Run` offers the claim's key to resume
  (`canResume`). Until applied, a run's payment holds its bills out of other runs: selecting, putting a bill back
  (`store#RunItem`) and paying it are refused while another run holds it (`RUN_ITEM_IN_OTHER_RUN`); a supplier that
  failed in an unfinished run releases its bills. An ACH run's bank account needs its
  NACHA fields (`BANK_ACCOUNT_NACHA_MISSING`). A check is numbered (`assign#BankAccountCheckNumber`), delivered and applied; an ACH
  payment is authorized. A supplier that fails has its reason on its bills, and the others keep their payments.
  `generate#RunFile` then writes the bank file once in its own transaction (`write#RunFile`): `generate#NachaFile` for
  ACH, which delivers the payments, or `generate#PositivePayFile` for checks when the bank account has a format, each
  with `paymentIdList` so the file holds the run's payments only; the delivered ACH payments are applied, each on its own
  (`apply#RunPayment`). Asking again (`generate#RunFile`, `get#RunFile`) gives the same file. A run never locks its
  organization: the postings and applications its payments make lock it in their own transactions.
- A run's discount is a prompt-payment credit (`create#InvoiceCreditMemo` `promptDiscount`, above), applied to the bill
  (`apply#InvoiceToInvoice`) before the payment.
- `void#RunApproval`: SECAs on `update#BankAccount`, `create#BankAccount` and `delete#PaymentMethod`. Mantle copies a
  changed outside party's bank account to a new payment method, so the change is found by the supplier: when an account
  of the supplier was ended, or an open ACH run pays it into an account that is no longer its newest current one, every
  open run paying the supplier takes its current bank account, and an approved one goes back to proposed with the reason
  (D26).
- `import#RunReturn` (`PAYMENT_EDIT`): the bank's NACHA return file through `import#NachaReturn`, which skips a payment
  already declined. Whatever imports a return, a delivered run payment that becomes Declined has its bills marked Returned
  with the bank's reason and the run's discount credits on them cancelled (the `RunPaymentReturned` SECA,
  `mark#RunPaymentReturned`, once).
- `get#Run` (`PAYABLE_VIEW`, `PAYMENT_VIEW` or `ACCOUNTING_VIEW`): the run and its bills with display text and masked bank
  accounts, and what the user may do. `cancel#Run` (`PAYABLE_EDIT`) cancels one not executed.

**Bank returns (F32).** A delivered payment that becomes Declined (a NACHA return) is unapplied (`PaymentUnDeliverCleanup`,
now before the reversal) and its posting reversed (`PaymentUndeliverReverGlPost`), as an undelivered one is;
`void#Payment` leaves a declined payment declined.

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

## Period close (P11)

`CloseServices` (logic in `ledger/PeriodClose.js`) closes an organization's fiscal period on Mantle's close.

- **Checklist.** `get#Checklist` gives the period's dates and order (ended, previous and child periods closed), then
  each `PeriodCloseCheck` enumeration in order: its service (enumCode, implementing `define#CloseCheck`) finds the
  period's items for the organization and the organizations that roll up to it, each naming the record that resolves
  it (`recordKind`, `recordId`, `text`, `detail`), and optionIndicator Y makes its items block. Mantle's rows
  (`check#StandardClose`): unposted transactions, the error journal (with each failure code), unbalanced transactions,
  unposted invoices, bills and payments, bank lines not on a finished statement, missing rates (all blocking), bills
  on hold, stock movements that posted nothing, open WIP on completed kit and repack work, and unposted project time.
  Each check runs in its own transaction; one that fails is unavailable and blocks. Another source adds a row with an
  enumeration and its own service.
- **Close.** `close#Period` (FISCAL_CLOSE; operation key) runs the checklist again under the period's lock and refuses
  `CLOSE_BLOCKED` naming each blocked row; then the run as CrnClosing, `close#FinancialTimePeriod` (now joining the
  caller's transaction and counting only the organization's and its rollup children's unposted transactions), the
  period's `GlAccountOrgTimePeriod` rows of the organization and of each organization that rolls up to it, computed from
  the posted entries and stored (every account with a posting before or in the period), for a fiscal year each one's
  `create#PeriodCloseAcctgTrans` to its own net income account (every closing entry posted, or the close rolls back) and
  the rows again, the later periods' existing rows carried forward, and the run closed with the checklist it passed.
  Closing entries are booked on the year's last day. With the posting guard on only that close's own closing entries
  pass the year's closed-period check (`post#AcctgTrans` `closingTimePeriodId`, checked against the closing run), never
  a lock, and FISCAL_CLOSE is asked of them; journal drafts, templates, instances and reversals refuse closing types
  (`CLOSING_ENTRY`), and `post#ReverseAcctgTrans` refuses to reverse a closing entry.
- **Reopen.** `reopen#Period` (FISCAL_REOPEN; a reason) calls `reopen#FinancialTimePeriod`, which refuses while the next
  or the parent period is closed, and marks the close run reopened with who, when and why.
- **Invoice reconciliation.** `LedgerReportServices.run#InvoiceReconciliation` (report read; the organization's own
  period): documents whose open amount differs from their receivable or payable postings, payments whose applied amount
  differs, unposted and unbalanced transactions, receivable or payable postings without an invoice, applications of the
  period to later invoices, and the aging's open total (summed in the query) against the ledger balance at the period's
  end. Each list is checked up to `listLimit` (500) documents or transactions; a longer one is reported in
  `incompleteChecks` with `complete` false.

## Period runs and project cost (P11)

- **Contract.** A `PeriodRunKind` enumeration names its calculation service (enumCode, `PeriodRunServices.define#RunCalculation`:
  one result per source with its amount and accounts, or a failure) and its posting service (optionValue,
  `define#RunPosting`). `preview#Run` (ACCOUNTING_GL_POST; an open period of the organization) stores an
  `AccountingPeriodRun` with its `AccountingPeriodRunResult` rows and a version, superseding the kind's earlier preview
  of the period; a calculation that fails is a failed run. `get#Run` reads one; `post#Run` (operation key) calculates
  again, refuses a changed version (`RUN_CHANGED`) and lets the kind post, then marks the run posted, partly posted or
  failed; a kind posts each result in its own transaction, so `post#Run` locks only the run. Logic in
  `ledger/PeriodRuns.js`.
- **Project cost.** `OtherAutoPostServices.post#WorkEffortCost` (logic in `ledger/ProjectCosts.js`), with
  `PartyAcctgPreference.projectCostPostingEnabled` (off by default; `store#Preferences` sets it): the time of a
  project's work at the entry's cost rate (its vendor rate, else its RateAmount), debiting `GatProjectLaborCost` and
  crediting `GatLaborClearing`, with the project on the `AttWorkEffortCost` transaction. Each time entry's
  `PostingOperation` (`wec:` and its id) lists its transaction lines; what should be posted (the cost while the week is
  approved) less what was posted posts on today's book day (or a run's). `approve#Timesheet`, `reopen#Timesheet`,
  `store#TimeEntry` and `delete#TimeEntry` (which reverses the entry's cost first) call it. The default clearing
  account is the employee wage expense payroll's earnings post to (631100000), so the reclass moves approved project
  time out of wage expense. Production work (no project) and an outside vendor's time are not posted. A failed posting goes to the
  error journal, and its entries wait until it posts. The project cost period run (`PrkProjectCost`,
  `calculate#` and `post#WorkEffortCostRun`) posts what is missing for a period.
## Fixed assets (P12)

`AssetBookServices` (logic in `ledger/FixedAssets.js`, beside Products' revaluation in `AssetBooks.js`) keeps an
organization's asset books on Mantle's Asset and AssetDepreciation. The organization is the asset's owner; a book day in a
closed fiscal period of it (or one it rolls up to) is refused (`PERIOD_CLOSED`); each write takes an operation key and a
retry answers the first.

- **Classes.** `FixedAssetClass` is an organization's dated versions of the book defaults of one `AssetClass`
  enumeration value: useful life, residual percent, book and tax methods, and the asset, accumulated depreciation,
  expense, gain and loss accounts (empty: the asset type's). `store#Class` (ACCOUNTING_ADMIN; a reason, audit-logged)
  starts a version and ends the one it replaces, or ends one, and refuses overlaps (`CLASS_OVERLAP`).
- **Book events.** Each writes an `AssetBookEvent` (create-only) with its posted transaction, accounts and the basis
  before and after it. `capitalize#Asset` (ACCOUNTING_GL_POST) adopts the class version of the in-service day for what
  is not given, writes the basis on the Asset (class, `acquiredDate`, cost, residual, method, `expectedEndOfLife`) and
  the accounts as the asset's own `AssetTypeGlAccount` row, and posts `AttCapitalization` from the offset account given
  (else Unreceived Fixed Asset) for an asset not received (a received one is reclassified only when the class's asset
  account differs; one whose receipt has not posted is refused). `adjust#AssetBook` changes cost (posted
  `AttAssetBookAdjust` against the same clearing), life and residual from a day forward. `dispose#Asset` (scrap or sale;
  refused while a month before it is not depreciated, `DEPRECIATION_DUE`) posts `AttAssetDisposal`: cost and accumulated
  depreciation out, proceeds to the asset's Unissued Fixed Asset account, the gain or loss, and ends the asset's life on
  the day. `reverse#AssetBookEvent` reverses the asset's latest event in force (`post#ReverseAcctgTrans`) and restores
  its basis; a capitalization or adjustment that depreciation used is not reversed (`EVENT_DEPRECIATED`).
  `repair#AcquireCost` (ACCOUNTING_ADMIN; a reason) is the audited data repair over
  `AssetServices.update#AssetAcquireCost`, refused while any posting of the asset is in a closed period (F39) and on a
  capitalized or disposed asset. `get#AssetBook` reads an asset's book for a user with GL posting, report read or
  finance administration in its organization.
- **Depreciation.** The `PrkDepreciation` period run kind (fiscal months): `calculate#DepreciationRun` gives the month's
  amount (`calculate#FixedAssetDepreciation`) of each fixed asset with a method, in service by the month's end, not
  disposed by it and without depreciation for it, or why it cannot be computed; `post#DepreciationRun` posts each ready
  asset in its own transaction through `post#AssetPeriodDepreciation` over `calculateAndPost#FixedAssetDepreciation`,
  refused (rolling back the transaction and its row) when it did not post or its amount changed from the run's. Disposed
  assets, and assets a posted invoice sells (whose posting now ends their life), are left out.
  `post#FixedAssetDepreciation` records no depreciation row or amount for a transaction that did not post, and deletes
  that transaction (F38, F260). `preview#Depreciation` (a class or assets), `get#DepreciationPreview` (each asset's
  cost, residual, depreciation before, the month and the net book after) and `post#Depreciation` are the screen's calls
  over `PeriodRunServices`.
- **Seed.** `FixedAssetData.xml`: the event types (`AbeCapitalize`, `AbeAdjust`, `AbeDispose`, `AbeReversal`,
  `AbeCostRepair`), the disposal types, the two transaction types and the run kind. DefaultSettings assigns the fixed
  asset accounts its type mappings name (F250).

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

## Budgets (P15)

`mantle.other.BudgetServices` and `BudgetReportServices`, with `other/Budgets.js`; the records are Mantle's `Budget`,
`BudgetItem`, `BudgetRevision`, `BudgetRevisionImpact`, `BudgetReview` and `BudgetParty`, with `BudgetControlPolicy`,
`BudgetCommitment` and `BudgetContent` (`entity/BudgetControlEntities.xml`). A budget's organization is its period's
party (`TimePeriod.partyId`); its other parties are `BudgetParty` rows (`store#BudgetParty`, `BUDGET_EDIT`).

- **States.** Draft, Approved, Closed and Cancelled (`StatusFlowTransition`). `create#Budget` makes a draft and records
  its creator; it and the item writers need `BUDGET_EDIT` in the budget's organization. `change#BudgetState` approves
  (`BUDGET_APPROVE`; a self-approval is stamped on the review; not by the creator unless `allowAccountingSelfApproval`;
  each account's sub periods must add up to its total), closes an approved budget or cancels a draft (`BUDGET_EDIT`,
  with a reason). The item writers (`store#BudgetItem`, `store#BudgetItemsSubPeriods`, `store#BudgetItemDetail`,
  `store#BudgetItemDetailsSubPeriods`) refuse a budget that is not a draft (`BUDGET_NOT_DRAFT`). The control and the
  BOSS lists read an approved budget as of its latest revision, never items written around `revise#Budget`.
- **Revisions.** Approval is revision `000`: a `BudgetRevision`, a `BudgetReview` and a `BudgetRevisionImpact` holding
  each item's amount. `revise#Budget` (`BUDGET_EDIT`) changes an approved budget's amounts (lines by item or by account
  and sub period, or the matrix form `glAccountId` with `amountMain` and `amountPer1`–`12`) as the next revision with its
  reason; `BudgetItem.amount` is audit-logged with the reason. `get#BudgetAmounts` and `run#BudgetVariance` read the
  amounts as of a revision (the latest impact of each item at or before it), or of the revision in effect at
  `asOfDate`. Each approval and revision stores its PDF (`template/other/Budget.print.html.fancy`) as `BudgetContent`;
  a PDF that cannot be made is logged and the revision stands.
- **Control.** `BudgetControlPolicy` rows are effective-dated with audit-logged key fields (`store#Policy`,
  `ACCOUNTING_ADMIN`, the `store#Rate` pattern): the organization, optionally a budget, an account and a stage (request,
  purchase order, expense), the action (Ignore, Warn, Stop) and a threshold percent. Spending of an account on a day
  counts against the approved budget's item for the sub period holding the day, else for its whole period. The decision
  compares the actual (posted debits less credits, without a period close's closing entries) and committed (open
  reserved commitments by `commitmentDate`) after the spending with the threshold: no policy or Ignore is not
  controlled, Warn reserves with a warning, Stop refuses (`BUDGET_EXCEEDED`) unless a user holding `BUDGET_OVERRIDE`
  gives an override reason. `check#Budget` previews it.
- **Commitments.** `reserve#Commitment` (request or order line), `convert#Commitment` (to the next stage; with
  `invoiceId`, a bill's posted debit lines) and `release#Commitment`, each idempotent per source line, revision and
  stage (a different amount or account under the same key is `SOURCE_REVISION_REUSED`; retries are checked again under
  the budget's lock). A new revision of a source line releases the earlier one's open commitment and holds its amount
  less what the earlier ones passed on. A converted commitment's open amount is its amount less what later stages hold
  (not blocked or reversed), and it is Converted when none is left, so committed and actual never count the same
  spending; a commitment converts only on its own account, and on another it gives up its share (a released child).
  Reserve and release need `INVOICE_APPROVE`, `BUDGET_EDIT` or `ACCOUNTING_ADMIN` in the organization, convert also
  `PAYABLE_EDIT`; release takes only a closed or cancelled source's commitments unless the user holds `BUDGET_OVERRIDE`
  or `ACCOUNTING_ADMIN`. A refused Stop is kept as a `BcBlocked` commitment, in its own transaction
  (`record#BlockedCommitment`, ordered by the budget item's lock; the commitment's relationships carry no foreign keys
  for this), and the `BudgetOverride` notification goes once to the organization's users holding `BUDGET_OVERRIDE`; the
  line's notice is marked read when it passes.
- **Bills.** `change#InvoiceState`'s approval of a bill (so `approve#Payable` too) calls `convert#Commitment` with the
  bill after its posting: each debit line of the posting in effect converts its purchase order line's open commitment
  (`OrderItemBilling`; each commitment's open amount used once across the bill's lines) and becomes an actual
  commitment, keyed by the bill's `approvedSourceVersion`; an account's lines are decided together, with the budgets
  locked in order, and `budgetOverrideReason` passes a Stop. When the approval is undone (Approved to Received) or the
  bill cancelled, the revert SECAs call `reverse#InvoiceActuals`: its actuals are Reversed and the order commitments
  open again. `get#InvoiceFinanceDetail`'s `budgetRows` are the invoice's commitments (F75).
- **Variance.** `run#BudgetVariance` (`ACCOUNTING_VIEW`) checks the organization and that the period is the budget's own
  or one of its sub periods (F6), and answers each account's budget as of the revision, committed, actual, remaining,
  variance and its percent (none for a zero budget). `run#BudgetExpenseReport` and `run#BudgetExpenseDetailReport` stay
  as they were for their callers.
- **Spec.** `AccountingBudgets`.

## Returns and order changes (P17)

**Flags.** Two audit-logged `PartyAcctgPreference` fields (`entity/ReturnSettlementEntities.xml`), off by default and set
through `store#Preferences`, since Mantle's ReturnToResponse and OrderToCash flows assert the old behavior:
- `returnSettlementRequired` (D11): `ReturnApprovedProcess` only creates the return shipment, `ShipmentDeliveredReturnReceive`
  and `ReturnReceivedProcess` stand aside, and responses come only from `settle#Return`. `ReturnServices.get#ReturnSettlementMode`
  answers whose return it is (the vendor of a customer return, the customer of a supplier return) and the flag.
- `salesInvoiceFinalizedAtShip` (D3): `ShipmentOutgoingPackedCreateInvoices` leaves the sales invoice in process with no
  payment applied, and `ShipmentShippedFinalizeInvoices` (shipped, or delivered unshipped) calls
  `InvoiceServices.finalize#ShipmentInvoices`, which dates it the ship day (invoice date, book day, due date), finalizes
  it and applies the order part's payments, as the pack did. A return shipment received through Mantle's own services
  under `returnSettlementRequired` sets each item's received quantity from its receipts (`sync#ReturnShipmentReceipts`).

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
- A customer return responds through the internal `respond#ReturnItems` with its `settlement` parameter (Mantle's
  `process#ReturnItemResponses` refuses a return under the flag, `RETURN_SETTLEMENT_REQUIRED`): the quantities given,
  each billing link with its receipt, original invoice line, receiptless flag, reason, approver, settler and operation key;
  the credit memo is the organization's receivable credit (F350), issued through `change#InvoiceState` (approved by the
  settler when invoice approval is required; a receiptless one approved by its settler, who needs `INVOICE_APPROVE` and
  `allowAccountingSelfApproval`); a credit is the
  customer credit account; a refund is spread over the order's captured payments, largest first, each a
  `create#RefundPayment` for the credit memo, delivered at once without a gateway. The settlement commits first
  (`record#ReturnSettlement`); then each gateway refund (`refund#SinglePayment`, keyed by the settlement's key and index)
  runs in its own transaction with its attempt recorded before the call (a `PaymentLifecycleEvent`), so a retry calls no
  gateway twice. A decline marks that refund declined, its amount refundable again, and leaves the credit and the other
  refunds (`REFUND_DECLINED`); a refund with no gateway answer is declined; a pending or unfinished call stays promised
  (`REFUND_PENDING`, read from the credit memos' refunds); a replacement is Mantle's replacement order for the quantity given, recorded on `replacedQuantity`.
- Adjustments are credited by their total times the share of the item credited so far, less what they credited before;
  a credit's unit is at most the billed unit price; a line asked twice is refused (`DUPLICATE_LINE`).
- A supplier return makes one credit per item, its adjustments netted in, through `create#InvoiceCreditMemo` linked to
  its bill (a payable draft),
  links the billing to the bill line and the PO receipt, and queues the bill's match re-evaluation.
- An item settled for all it authorizes is completed with its children (`complete#ReturnItem`); a receiptless one first
  has its remainder closed (ReturnReceived).

**Between pack and ship.** `InvoiceServices.release#ShipmentDraftInvoice` (`RECEIVABLE_EDIT`): before the shipment ships,
the invoice lines billed for it and their billing links are removed, its sources and issuances no longer name the invoice,
and an invoice left with no line is cancelled, so packing again bills it again; a shipped shipment (`SHIPMENT_SHIPPED`) or
an invoice no longer in process (`INVOICE_FINALIZED`) is refused. `PaymentServices.refund#OrderPayment` (`PAYMENT_EDIT`)
refunds a captured order payment through `create#RefundPayment`, with the gateway's `refund#SinglePayment` when the
payment has one, within what is unapplied and not refunded (`get#PaymentRefundSummary`). Both take an operation key.

## Portals (P18)

Accounting's customer and supplier pages are the PASS Billing and Supplier apps (mr-pass); what they reach is here.

- **External access (CX-PORTALS).** `mantle.party.ExternalAccessCapability` is one record of an organization for its
  outside party: `recordType` (Invoice or Order) and `recordId`, the revision issued, `scopes` (InvoicePay; BillUpload
  and OrderAcknowledgement), expiry, revocation and the digest of a bearer token shown once.
  `mantle.party.ExternalAccessServices` (logic in `party/ExternalAccess.js`): `create#AccessCapability` (an issued
  customer invoice with `RECEIVABLE_EDIT`, a purchase order with `PAYABLE_EDIT`, in the record's organization; answers
  the record's page on the organization's site), `revoke#`, `find#AccessCapabilities`, `check#AccessToken` (misses limited
  per requester) and `check#AccessCapability` (a token's record within its scope, or a record whose outside party the
  signed-in user holds a contact grant for, on that organization's app; anything else NotFound). `invite#Contact` makes a
  PASS invitation bound to an app and an outside organization; `redeem#Invitation` then gives the account's party an
  `ExternalAccessContact` grant for that organization, app and party, with no user group. Every token lookup counts
  against the requester's limit (the framework's `requesterKey`) before it is made. A new pay link revokes the earlier
  ones its issuer kind made (`issuerKind`: the organization's, or a contact's).
- **Site apps.** `public/PublicApps.js` lists the apps a site may mount; Billing and Supplier take an internal
  organization as target (`PublicSiteApp.targetId`), which only an operator sets and a core mount save keeps, and add
  readiness checks (`check#AppReadiness`). `pageUrl` builds a page's address from the canonical host and the mount.
- **Portal services.** `mantle.account.PortalServices` (logic in `account/Portal.js`), each taking PASS's `input` map,
  finding the organization the site's app serves and checking the capability or contact first:
  `issue#InvoiceAccess` (a pay link: `send#Invoice` mails it when the organization has a Billing site; a contact can
  make one to share), `find#Invoices`, `get#Invoice` (number, dates, lines, total, paid and due only),
  `start#InvoicePayment`, `get#PaymentResult`, `submit#SupplierBill` and `get#Submission`. Each is an operation in
  `forum/ForumSchema.js` and `script/PassRoutes.js`, served by `PassApi`, which takes the two token writes from a
  registered deployment without a session and a file for any operation with one.
- **Invoice payment.** The organization's gateway is `PartyAcctgPreference.invoicePayGatewayConfigId` (one of its
  PaymentGatewayOrganization bindings; `store#Preferences`). `start#InvoicePayment` locks the invoice, answers a retried
  operation, resumes an attempt still pending, else creates a promised card payment for what is due
  (`forInvoiceId`) with its `PortalPaymentAttempt` (in its own transaction), then calls `authorize#SinglePayment` with
  `returnUrl`, the app's return path carrying the attempt and a reference only it holds. The pages show, refresh and
  capture only portal attempts; the invoice page and the `resolve_PortalPayments` job (unsettled attempts only) ask the
  gateway; an attempt with nothing to ask and no page after five minutes, or pending for seven days, is cancelled. The
  return reference reads its attempt while pending and for a day after it settles, while the invoice is issued. A hosted gateway answers
  pending with its page (`PaymentGatewayResponse.redirectUrl`); `get#PaymentResult` asks the gateway
  (`get#SinglePaymentGatewayDetails`) and captures an authorization, and `PaymentApplyForInvoice` applies a delivered
  payment. Nothing the payer's browser brings back is read. Test gateway: `hostedPending#PaymentAuthorization`,
  `alwaysPending#` and `alwaysDecline#PaymentDetails`.
- **Supplier bills.** `submit#SupplierBill` answers a repeat of the operation or of the supplier's bill number with the
  first `SupplierBillSubmission`, stages the file under `pass_media_root/bills`, checks its leading bytes are the PDF,
  PNG or JPEG it says (kept with that extension) and scans it (`pass_scanner_service`),
  and makes the incoming draft through `import#Bill`'s core (`Payables.js` `portalBill`, the capability in place of
  `PAYABLE_IMPORT`), the file becoming its content only when clean. It never approves.
- **Posting guard.** While Portal.js completes one checked portal payment it names it in the execution context's shared
  map (`PostingGuard.PORTAL_PAYMENT`); that payment's posting, or its application's, to the organization it is paid to
  skips the user's organization check. Nothing else does (F378).

## Libraries

- `ledger/EntityLib.js`: the helpers the finance modules share: entity reads without artifact authorization (each
  module checks its permissions first), calls and probes, dates and book days (`bookDay`: the calendar day, else the
  timestamp's day in the user's zone), display values, amounts, refusals with reason codes (`denied`, `reasonCode`),
  party names that leave out private parties, paging and operation keys. Nothing in it authorizes.
- `ledger/AccountingPolicy.js`: permissions, organization scope and record checks; a refusal has a reason code.
- `ledger/PostingGuard.js`: the posting choke point. It decides an automatic posting from the transaction's source
  fields, and asks `ACCOUNTING_GL_POST` of a manual or reversal posting unless its caller passes `reviewed`.
- `account/InvoiceWorkflowLib.js`: an invoice's scope for a read or a write, and the hold guard. `Payables.js`,
  `InvoiceMatch.js`, `InvoiceWorkflow.js`, `PaymentTerms.js`, `PaymentRuns.js`,
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
./moq test mr-mantle --spec AccountingPaymentRuns,AccountingPaymentRunControls,BankOutputFiles
./moq test mr-mantle --spec AccountingBankReconciliation,BankFileServices
./moq test mr-mantle --spec AccountingPeriodClose,AccountingProjectCost
./moq test mr-mantle --spec AccountingTax,TaxStatementServices
./moq test mr-mantle --spec AccountingBudgets,BudgetServices
./moq test mr-mantle --spec AccountingReturns,ReturnToResponseBasicFlow,OrderToCashBasicFlow
./moq test mr-mantle --spec AccountingPortals
```

The PDF specs need a Chromium for PDF (`pdf_chromium_path`; see [Run-Deploy](../../../../docs/Run-Deploy.md) and
[Client-Testing](../../../../docs/dev/Client-Testing.md)); without one every PDF spec fails. The results are in
mr-boss's `plan/impl-accounting.md`.
