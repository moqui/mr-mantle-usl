const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const SUMMARY = "mantle.ledger.transaction.AcctgTransAndEntrySummary"
function base(p, before = false) {
    const s = lib.organization(p, "reportRead")
    lib.dimensions(s.organizationPartyId, p)
    if (p.amountUomId) lib.currency(p.amountUomId)
    let q = lib.find(SUMMARY, {
        organizationPartyId: s.organizationPartyId,
        isPosted: "Y"
    })
    for (const field of ["glAccountId", "amountUomId", "debitCreditFlag", "amount"]) q = q.selectField(field)
    if (p.glAccountId) {
        lib.record({
            kind: "accounts",
            recordId: p.glAccountId,
            organizationPartyId: s.organizationPartyId
        })
        q = q.condition("glAccountId", p.glAccountId)
    }
    if (p.amountUomId) q = q.condition("amountUomId", p.amountUomId)
    if (p.facilityId) q = q.condition("facilityId", p.facilityId)
    if (p.costCenterId) q = q.condition("costCenterId", p.costCenterId)
    const dates = before
        ? lib.accountingDateCondition({
              thruDate: p.fromDate || new Date(0),
              thruDay: p.fromAccountingDate || "1970-01-01"
          })
        : lib.accountingDateCondition({
              fromDate: p.fromDate,
              thruDate: p.thruDate,
              fromDay: p.fromAccountingDate,
              thruDay: p.thruAccountingDate
          })
    if (dates) q = q.condition(dates)
    return {q, s}
}
function options(p) {
    const out = Object.assign({}, p)
    // Always recompute these internal bounds; comparison options may inherit the main report's values.
    out.fromAccountingDate = p.fromDate ? ec.l10n.format(p.fromDate, "yyyy-MM-dd") : null
    out.thruAccountingDate = p.thruDate ? ec.l10n.format(p.thruDate, "yyyy-MM-dd") : null
    delete out.period
    if (p.timePeriodId) {
        const period = lib.record({
            kind: "periods",
            recordId: p.timePeriodId,
            organizationPartyId: p.organizationPartyId
        })
        // the period's days start at midnight in the user's zone, as undated postings are booked by that zone's day
        const fromDay = lib.calendarDateText(period.fromDate)
        const afterDay = lib.calendarDateText(Date.parse(lib.calendarDateText(period.thruDate)) + 86400000)
        out.fromDate = ec.l10n.parseTimestamp(fromDay, "yyyy-MM-dd")
        out.thruDate = ec.l10n.parseTimestamp(afterDay, "yyyy-MM-dd")
        out.fromAccountingDate = fromDay
        out.thruAccountingDate = afterDay
        out.period = period
    }
    if (
        (out.fromDate && !Number.isFinite(lib.ms(out.fromDate))) ||
        (out.thruDate && !Number.isFinite(lib.ms(out.thruDate))) ||
        (out.fromDate && out.thruDate && lib.ms(out.fromDate) >= lib.ms(out.thruDate))
    )
        throw new Error("Choose an increasing report date range")
    return out
}
function trial(p) {
    p = options(p)
    const {q, s} = base(p),
        totals = new Map()
    const entry = r => {
        const key = r.glAccountId + ":" + r.amountUomId
        if (!totals.has(key))
            totals.set(key, {
                glAccountId: r.glAccountId,
                amountUomId: r.amountUomId,
                beginning: toDecimal(0),
                debits: toDecimal(0),
                credits: toDecimal(0),
                ending: toDecimal(0)
            })
        return totals.get(key)
    }
    const movement = Array.from(q.list()),
        beginning = Array.from(base(p, true).q.list())
    if (p.period?.isClosed === "Y" && !p.facilityId && !p.costCenterId) {
        const currencies = [...new Set(movement.map(r => r.amountUomId))],
            baseCurrency = lib.preference(s.organizationPartyId).baseCurrencyUomId
        if (p.amountUomId && p.amountUomId !== baseCurrency && !movement.length)
            return {
                reportRows: [],
                organizationPartyId: s.organizationPartyId,
                asOf: ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd HH:mm:ss"),
                complete: true
            }
        if (currencies.some(c => c !== baseCurrency)) throw new Error("Closed-period summaries cannot represent mixed currencies")
        let summaries = lib.find("mantle.ledger.account.GlAccountOrgTimePeriod", {
            organizationPartyId: s.organizationPartyId,
            timePeriodId: p.timePeriodId
        })
        if (p.glAccountId) summaries = summaries.condition("glAccountId", p.glAccountId)
        const stored = Array.from(summaries.list())
        if ([...movement, ...beginning].some(r => !stored.some(summary => summary.glAccountId === r.glAccountId)))
            throw new Error("Closed-period summary is incomplete; run period close reconciliation")
        for (const row of stored)
            Object.assign(
                entry({
                    glAccountId: row.glAccountId,
                    amountUomId: baseCurrency
                }),
                {
                    beginning: toDecimal(row.beginningBalance || 0),
                    debits: toDecimal(row.postedDebits || 0),
                    credits: toDecimal(row.postedCredits || 0),
                    ending: toDecimal(row.endingBalance || 0),
                    closedSummary: true
                }
            )
    } else {
        for (const row of beginning) {
            const total = entry(row)
            total.beginning = total.beginning.add(toDecimal(row.amount).multiply(row.debitCreditFlag === "D" ? 1 : -1))
        }
        for (const row of movement) {
            const total = entry(row)
            const field = row.debitCreditFlag === "D" ? "debits" : "credits"
            total[field] = total[field].add(row.amount)
        }
        for (const row of totals.values()) row.ending = row.beginning.add(row.debits).subtract(row.credits)
    }
    const ids = [...new Set([...totals.values()].map(r => r.glAccountId))]
    const names = Object.fromEntries(
        ids.length
            ? Array.from(lib.find("mantle.ledger.account.GlAccount").condition("glAccountId", "in", ids).list()).map(r => [
                  r.glAccountId,
                  {name: r.accountName, isDebit: r.isDebit}
              ])
            : []
    )
    return {
        reportRows: [...totals.values()].map(r => {
            const account = names[r.glAccountId]
            if (r.closedSummary && account?.isDebit !== "Y") {
                r.beginning = r.beginning.negate()
                r.ending = r.ending.negate()
            }
            return Object.assign(r, {accountName: account?.name})
        }),
        asOf: ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd HH:mm:ss"),
        organizationPartyId: s.organizationPartyId,
        complete: true
    }
}
function ledger(p) {
    p = options(p)
    const {s} = base(p)
    let q = lib.find("mantle.ledger.transaction.AcctgTransAndEntry", {
        organizationPartyId: s.organizationPartyId,
        isPosted: "Y"
    })
    for (const field of ["glAccountId", "amountUomId", "facilityId", "costCenterId"])
        if (p[field]) q = q.condition(field, p[field])
    const dates = lib.accountingDateCondition({
        fromDate: p.fromDate,
        thruDate: p.thruDate,
        fromDay: p.fromAccountingDate,
        thruDay: p.thruAccountingDate
    })
    if (dates) q = q.condition(dates)

    const balances = {}
    for (const row of Array.from(base(p, true).q.list())) {
        const key = row.glAccountId + ":" + row.amountUomId
        balances[key] = (balances[key] || toDecimal(0)).add(toDecimal(row.amount).multiply(row.debitCreditFlag === "D" ? 1 : -1))
    }
    const selected = Array.from(q.orderBy("glAccountId,transactionDate,acctgTransId,acctgTransEntrySeqId").limit(10001).list())
    if (selected.length > 10000) throw new Error("Narrow the ledger to at most 10,000 lines")
    // The bounded result must run in book-day order even when creators use different time zones.
    const effectiveDay = row =>
        row.accountingDate ? lib.calendarDateText(row.accountingDate) : ec.l10n.format(row.transactionDate, "yyyy-MM-dd")
    selected.sort(
        (a, b) =>
            a.glAccountId.localeCompare(b.glAccountId) ||
            effectiveDay(a).localeCompare(effectiveDay(b)) ||
            lib.ms(a.transactionDate) - lib.ms(b.transactionDate) ||
            a.acctgTransId.localeCompare(b.acctgTransId) ||
            a.acctgTransEntrySeqId.localeCompare(b.acctgTransEntrySeqId)
    )
    const reportRows = selected.map(row => {
        const key = row.glAccountId + ":" + row.amountUomId
        balances[key] = (balances[key] || toDecimal(0)).add(toDecimal(row.amount).multiply(row.debitCreditFlag === "D" ? 1 : -1))
        return Object.assign(lib.display(row), {
            debits: row.debitCreditFlag === "D" ? row.amount : toDecimal(0),
            credits: row.debitCreditFlag === "C" ? row.amount : toDecimal(0),
            ending: balances[key]
        })
    })
    return {
        reportRows,
        organizationPartyId: s.organizationPartyId,
        asOf: ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd HH:mm:ss"),
        complete: true
    }
}
function report(op, p) {
    const result = (op === "trial" ? trial : ledger)(p)
    if (!p.compareFromDate && !p.compareThruDate) return Object.assign(result, {comparisonRows: []})
    if (!p.compareFromDate || !p.compareThruDate) throw new Error("Choose both comparison dates")
    const comparison = (op === "trial" ? trial : ledger)(
        Object.assign({}, p, {
            timePeriodId: null,
            fromDate: p.compareFromDate,
            thruDate: p.compareThruDate
        })
    )
    if (op === "trial") {
        const values = new Map(comparison.reportRows.map(row => [row.glAccountId + ":" + row.amountUomId, row]))
        for (const row of result.reportRows) {
            const key = row.glAccountId + ":" + row.amountUomId
            row.comparisonEnding = values.get(key)?.ending || toDecimal(0)
            row.change = row.ending.subtract(row.comparisonEnding)
            values.delete(key)
        }
        for (const row of values.values())
            result.reportRows.push(
                Object.assign({}, row, {
                    beginning: toDecimal(0),
                    debits: toDecimal(0),
                    credits: toDecimal(0),
                    ending: toDecimal(0),
                    comparisonEnding: row.ending,
                    change: row.ending.negate()
                })
            )
    }
    return Object.assign(result, {comparisonRows: comparison.reportRows})
}
// The invoice reconciliation of a fiscal period (design §13 InvoiceReconciliation): for receivables or payables, the
// period's documents whose open amount differs from their receivable or payable postings, the payments whose applied
// amount differs from theirs, unposted and unbalanced transactions, receivable or payable postings without an invoice,
// and applications of the period to invoices dated after it; with the aging's open total against the ledger balance at
// the period's end. The organization's own records only, and a period of the organization.
const RECEIVABLE_STATUSES = ["InvoiceFinalized", "InvoiceSent", "InvoiceAcked", "InvoicePmtRecvd", "InvoiceWriteOff"]
const PAYABLE_STATUSES = ["InvoiceApproved", "InvoicePmtSent", "InvoiceBilledThrough"]
function invoiceReconciliation(p) {
    const s = lib.organization(p, "reportRead")
    if (!p.timePeriodId) throw new Error("PERIOD_REQUIRED: Choose a fiscal period")
    const period = lib.record({kind: "periods", recordId: p.timePeriodId, organizationPartyId: s.organizationPartyId})
    if (period.partyId !== s.organizationPartyId) lib.denied("PERIOD_UNAVAILABLE", "Choose a fiscal period of this organization")
    const org = s.organizationPartyId
    const payable = p.invoiceType === "payable"
    const accountClass = payable ? "ACCOUNTS_PAYABLE" : "ACCOUNTS_RECEIVABLE"
    const sign = payable ? -1 : 1
    const fromDay = lib.calendarDateText(period.fromDate)
    const afterDay = lib.calendarDateText(Date.parse(lib.calendarDateText(period.thruDate)) + 86400000)
    const fromStamp = ec.l10n.parseTimestamp(fromDay, "yyyy-MM-dd"),
        afterStamp = ec.l10n.parseTimestamp(afterDay, "yyyy-MM-dd")
    const inPeriod = lib.accountingDateCondition({fromDate: fromStamp, thruDate: afterStamp, fromDay, thruDay: afterDay})
    const toEnd = lib.accountingDateCondition({thruDate: afterStamp, thruDay: afterDay})
    const cf = ec.entity.conditionFactory
    const invoiceInPeriod = cf.makeCondition(
        [
            cf.makeCondition(
                [
                    cf.makeCondition("accountingDate", "is-not-null", null),
                    cf.makeCondition("accountingDate", "greater-equals", fromDay),
                    cf.makeCondition("accountingDate", "less", afterDay)
                ],
                "and"
            ),
            cf.makeCondition(
                [
                    cf.makeCondition("accountingDate", "is-null", null),
                    cf.makeCondition("invoiceDate", "greater-equals", fromStamp),
                    cf.makeCondition("invoiceDate", "less", afterStamp)
                ],
                "and"
            )
        ],
        "or"
    )
    const currency = lib.preference(org).baseCurrencyUomId
    const reportRows = []
    const add = (check, checkText, sourceKind, sourceId, description, documentAmount, glAmount) =>
        reportRows.push({
            check,
            checkText,
            sourceKind,
            sourceId,
            description: description || "",
            documentAmount,
            glAmount,
            difference: documentAmount != null && glAmount != null ? toDecimal(documentAmount).subtract(glAmount) : null
        })
    // the net on the receivable or payable accounts of the postings of some documents, through the period's end
    const glNet = (field, ids) => {
        const out = {}
        if (!ids.length) return out
        for (const row of lib
            .find("mantle.ledger.transaction.AcctgTransAndEntryGlaSummary", {organizationPartyId: org, isPosted: "Y"})
            .condition(field, "in", ids)
            .condition("glAccountClassEnumId", accountClass)
            .condition(toEnd)
            .selectField(field)
            .selectField("debitCreditFlag")
            .selectField("amount")
            .list())
            out[row[field]] = (out[row[field]] || toDecimal(0)).add(
                toDecimal(row.amount ?? 0).multiply(row.debitCreditFlag === "D" ? sign : -sign)
            )
        return out
    }
    const appliedThroughEnd = (field, ids) => {
        const out = {}
        if (!ids.length) return out
        for (const row of lib
            .find("mantle.account.payment.PaymentApplication")
            .condition(field, "in", ids)
            .condition("appliedDate", "less", afterStamp)
            .list())
            out[row[field]] = (out[row[field]] || toDecimal(0)).add(toDecimal(row.amountApplied ?? 0))
        return out
    }
    // documents of the period, at most listLimit of each kind: a longer list is reported incomplete, never as no
    // differences
    const limit = Math.max(0, Number(p.listLimit ?? 500))
    const incompleteChecks = []
    const bounded = (check, list) => {
        if (list.length <= limit) return list
        incompleteChecks.push(check)
        return list.slice(0, limit)
    }
    const invoices = bounded(
        "invoiceVsGl",
        Array.from(
            lib
                .find("mantle.account.invoice.Invoice", {[payable ? "toPartyId" : "fromPartyId"]: org})
                .condition("statusId", "in", payable ? PAYABLE_STATUSES : RECEIVABLE_STATUSES)
                .condition(invoiceInPeriod)
                .orderBy("invoiceDate,invoiceId")
                .limit(limit + 1)
                .list()
        )
    )
    const invoiceIds = invoices.map(row => row.invoiceId)
    const invoiceGl = glNet("invoiceId", invoiceIds),
        invoiceApplied = appliedThroughEnd("invoiceId", invoiceIds)
    for (const invoice of invoices) {
        const open = toDecimal(invoice.invoiceTotal ?? 0).subtract(invoiceApplied[invoice.invoiceId] || toDecimal(0))
        const gl = invoiceGl[invoice.invoiceId] || toDecimal(0)
        if (!open.eq(gl))
            add(
                "invoiceVsGl",
                "Open amount differs from the ledger",
                payable ? "bills" : "invoices",
                invoice.invoiceId,
                invoice.description || invoice.referenceNumber,
                open,
                gl
            )
    }
    const payments = bounded(
        "paymentVsGl",
        Array.from(
            lib
                .find("mantle.account.payment.Payment", {[payable ? "fromPartyId" : "toPartyId"]: org})
                .condition("statusId", "in", ["PmntDelivered", "PmntConfirmed"])
                .condition("effectiveDate", "greater-equals", fromStamp)
                .condition("effectiveDate", "less", afterStamp)
                .orderBy("effectiveDate,paymentId")
                .limit(limit + 1)
                .list()
        )
    )
    const paymentIds = payments.map(row => row.paymentId)
    const paymentGl = glNet("paymentId", paymentIds),
        paymentApplied = appliedThroughEnd("paymentId", paymentIds)
    for (const payment of payments) {
        const applied = paymentApplied[payment.paymentId] || toDecimal(0)
        const gl = (paymentGl[payment.paymentId] || toDecimal(0)).negate()
        if (!applied.eq(gl))
            add(
                "paymentVsGl",
                "Applied amount differs from the ledger",
                "payments",
                payment.paymentId,
                payment.paymentRefNum || payment.comments,
                applied,
                gl
            )
    }
    // transactions of the period
    const unpostedTransactions = bounded(
        "notPosted",
        Array.from(
            lib
                .find("mantle.ledger.transaction.AcctgTrans", {organizationPartyId: org})
                .condition(
                    cf.makeCondition(
                        [cf.makeCondition("isPosted", "is-null", null), cf.makeCondition("isPosted", "equals", "N")],
                        "or"
                    )
                )
                .condition(inPeriod)
                .orderBy("acctgTransId")
                .limit(limit + 1)
                .list()
        )
    )
    for (const tx of unpostedTransactions)
        add(
            "notPosted",
            "Transaction not posted",
            "journals",
            tx.acctgTransId,
            tx.description || tx.acctgTransTypeEnumId,
            null,
            null
        )
    const net = {}
    for (const row of lib
        .find("mantle.ledger.transaction.AcctgTransAndEntrySummary", {organizationPartyId: org, isPosted: "Y"})
        .condition(inPeriod)
        .selectField("acctgTransId")
        .selectField("debitCreditFlag")
        .selectField("amount")
        .list())
        net[row.acctgTransId] = (net[row.acctgTransId] || toDecimal(0)).add(
            toDecimal(row.amount ?? 0).multiply(row.debitCreditFlag === "D" ? 1 : -1)
        )
    for (const id of Object.keys(net).sort())
        if (!net[id].isZero()) add("unbalanced", "Debits and credits differ", "journals", id, null, null, net[id])
    const noInvoice = {}
    for (const row of lib
        .find("mantle.ledger.transaction.AcctgTransAndEntryGlaSummary", {organizationPartyId: org, isPosted: "Y"})
        .condition("glAccountClassEnumId", accountClass)
        .condition("invoiceId", "is-null", null)
        .condition("reverseOfAcctgTransId", "is-null", null)
        .condition("reversedByAcctgTransId", "is-null", null)
        .condition(inPeriod)
        .selectField("acctgTransId")
        .selectField("debitCreditFlag")
        .selectField("amount")
        .list())
        noInvoice[row.acctgTransId] = (noInvoice[row.acctgTransId] || toDecimal(0)).add(
            toDecimal(row.amount ?? 0).multiply(row.debitCreditFlag === "D" ? sign : -sign)
        )
    for (const id of Object.keys(noInvoice).sort())
        add(
            "noInvoice",
            (payable ? "Payable" : "Receivable") + " posting without an invoice",
            "journals",
            id,
            null,
            null,
            noInvoice[id]
        )
    for (const row of lib
        .find("mantle.account.payment.PaymentApplicationAndInvoice", {[payable ? "toPartyId" : "fromPartyId"]: org})
        .condition("appliedDate", "greater-equals", fromStamp)
        .condition("appliedDate", "less", afterStamp)
        .condition("invoiceDate", "greater-equals", afterStamp)
        .list())
        add(
            "applicationAfterPeriod",
            "Applied in the period to a later invoice",
            payable ? "bills" : "invoices",
            row.invoiceId,
            "Payment " + row.paymentId,
            row.amountApplied,
            null
        )
    // the aging's open total against the ledger at the period's end, summed in the queries
    const side = payable ? "toPartyId" : "fromPartyId"
    const statuses = payable ? PAYABLE_STATUSES : RECEIVABLE_STATUSES
    const issued = lib
        .find("mantle.account.invoice.InvoiceTotalSum", {[side]: org})
        .condition("statusId", "in", statuses)
        .condition("invoiceDate", "less", afterStamp)
        .selectField("invoiceTotalSum")
        .one()
    const applied = lib
        .find("mantle.account.payment.InvoiceAppliedSum", {[side]: org})
        .condition("statusId", "in", statuses)
        .condition("invoiceDate", "less", afterStamp)
        .condition("appliedDate", "less", afterStamp)
        .selectField("amountAppliedSum")
        .one()
    const agingOpen = toDecimal(issued?.invoiceTotalSum ?? 0).subtract(toDecimal(applied?.amountAppliedSum ?? 0))
    let ledgerBalance = toDecimal(0)
    for (const row of lib
        .find("mantle.ledger.transaction.AcctgTransAndEntryGlaSummary", {organizationPartyId: org, isPosted: "Y"})
        .condition("glAccountClassEnumId", accountClass)
        .condition(toEnd)
        .selectField("debitCreditFlag")
        .selectField("amount")
        .list())
        ledgerBalance = ledgerBalance.add(toDecimal(row.amount ?? 0).multiply(row.debitCreditFlag === "D" ? sign : -sign))
    return {
        reportRows,
        summary: {agingOpen, ledgerBalance, difference: agingOpen.subtract(ledgerBalance), currencyUomId: currency},
        complete: !incompleteChecks.length,
        incompleteChecks,
        period: Object.assign(lib.display(period), {fromDay, thruDay: lib.calendarDateText(period.thruDate)}),
        organizationPartyId: org,
        asOf: ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd HH:mm:ss")
    }
}
;({
    execute: (op, p) => {
        if (op === "invoiceReconciliation") return invoiceReconciliation(p)
        if (!["trial", "ledger"].includes(op)) throw new Error("Unknown finance report")
        return report(op, p)
    }
})
