// Payment terms: a term's installment and discount lines (SettlementTermLine, effective-dated), the due schedule an
// invoice keeps from them when it is issued (InvoiceDueSchedule), and the prompt-payment discount open on a day. Dates
// are computed as checkSet#InvoiceDueDate computes the due date: days after the invoice date in the server's zone.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const {find, one, rows, call, denied} = lib
const I = lib.invoiceEntity,
    L = "mantle.account.invoice.SettlementTermLine",
    S = "mantle.account.invoice.InvoiceDueSchedule"
const lineFields = ["sequenceNum", "portionPercent", "daysBasis", "discountPercent", "discountDays"]

// The lines of a term in effect on a date, in sequence.
function linesInEffect(settlementTermId, date = ec.user.nowTimestamp) {
    if (!settlementTermId) return []
    const cf = ec.entity.conditionFactory
    return Array.from(
        find(L, {settlementTermId})
            .condition("fromDate", "less-equals", date)
            .condition(
                cf.makeCondition(
                    [cf.makeCondition("thruDate", "is-null", null), cf.makeCondition("thruDate", "greater", date)],
                    "or"
                )
            )
            .orderBy("sequenceNum")
            .list()
    )
}
const number = (value, label) => {
    if (value == null || value === "" || isNaN(Number(value))) denied("TERM_LINE_INVALID", "Give the " + label + " of each line")
    return toDecimal(value)
}
// The lines a request gives, checked: portions over 0 that add up to 100, whole days, a discount of 0 to 100 percent
// within the portion's days.
function requestedLines(value) {
    let list = value == null || value === "" ? [] : value
    if (typeof list === "string") list = lib.json(list, null)
    if (!Array.isArray(list) && !(list && typeof list.length === "number")) denied("TERM_LINE_INVALID", "Give the term's lines")
    list = Array.from(list)
    if (list.length > 12) denied("TERM_LINE_INVALID", "A term has at most 12 lines")
    const lines = list.map((row, index) => {
        const portionPercent = number(row.portionPercent, "portion"),
            daysBasis = number(row.daysBasis, "due days"),
            discountPercent = toDecimal(row.discountPercent || 0),
            discountDays = toDecimal(row.discountDays || 0)
        if (portionPercent.compare(0) <= 0 || portionPercent.compare(100) > 0)
            denied("TERM_LINE_INVALID", "A line's portion is more than 0 and at most 100 percent")
        if (daysBasis.compare(0) < 0 || discountDays.compare(0) < 0 || discountPercent.compare(0) < 0)
            denied("TERM_LINE_INVALID", "Days and discounts are not negative")
        if (discountPercent.compare(100) >= 0) denied("TERM_LINE_INVALID", "A discount is less than 100 percent")
        if (discountDays.compare(daysBasis) > 0) denied("TERM_LINE_INVALID", "A discount ends on or before its portion is due")
        if (discountPercent.isZero() && !discountDays.isZero())
            denied("TERM_LINE_INVALID", "A line with discount days needs a discount percent")
        return {
            sequenceNum: index + 1,
            portionPercent: String(portionPercent),
            daysBasis: Math.trunc(daysBasis.toNumber()),
            discountPercent: String(discountPercent),
            discountDays: Math.trunc(discountDays.toNumber())
        }
    })
    if (lines.length) {
        const total = lines.reduce((sum, row) => sum.add(row.portionPercent), toDecimal(0))
        if (!total.eq(100)) denied("TERM_PORTIONS_INVALID", "The portions of a term add up to 100 percent")
    }
    return lines
}
// The days of a term with the lines given: its last portion's; null when no lines are given.
function lineDays(value) {
    if (value == null || value === "") return null
    const lines = requestedLines(value)
    return lines.length ? Math.max(...lines.map(row => row.daysBasis)) : null
}
const sameLines = (current, requested) =>
    current.length === requested.length &&
    current.every((row, index) =>
        lineFields.every(field => toDecimal(row[field] ?? 0).eq(toDecimal(requested[index][field] ?? 0)))
    )
// Replace a term's lines in effect: the lines in effect end now and the new ones start now; the same lines change nothing.
// No lines given leaves them as they are; an empty list ends them. Called by store#SettlementTerm, which checked the
// permission and the term.
function storeLines(p) {
    if (p.lines == null) return {linesChanged: false}
    const requested = requestedLines(p.lines),
        now = ec.user.nowTimestamp,
        current = linesInEffect(p.settlementTermId, now)
    if (sameLines(current, requested)) return {linesChanged: false, lineCount: current.length}
    for (const row of current)
        call("update#" + L, {
            settlementTermLineId: row.settlementTermLineId,
            thruDate: now,
            thruDate_changeReason: p.changeReason
        })
    for (const row of requested)
        call(
            "create#" + L,
            Object.assign({}, row, {
                settlementTermId: p.settlementTermId,
                fromDate: now,
                changeReason: p.changeReason,
                changedByUserId: ec.user.userId
            })
        )
    return {linesChanged: true, lineCount: requested.length}
}
// The terms' lines in effect now, for the settings screen.
function termLines(p) {
    const cf = ec.entity.conditionFactory,
        now = ec.user.nowTimestamp
    const found = Array.from(
        find(L)
            .condition("fromDate", "less-equals", now)
            .condition(
                cf.makeCondition(
                    [cf.makeCondition("thruDate", "is-null", null), cf.makeCondition("thruDate", "greater", now)],
                    "or"
                )
            )
            .orderBy("settlementTermId,sequenceNum")
            .limit(500)
            .list()
    )
    return {
        termLines: found.map(row =>
            Object.assign(lib.display(row), {
                lineText:
                    String(row.portionPercent) +
                    "% due in " +
                    row.daysBasis +
                    " days" +
                    (toDecimal(row.discountPercent || 0).isZero()
                        ? ""
                        : ", " + String(row.discountPercent) + "% off within " + row.discountDays + " days")
            })
        )
    }
}
function addDays(date, days) {
    const value = new Date(Number(date))
    value.setDate(value.getDate() + days)
    return value.getTime()
}
// The end of a timestamp's day in the server's zone: a discount may be taken through its last day.
function endOfDay(time) {
    const value = new Date(Number(time))
    value.setHours(23, 59, 59, 999)
    return value.getTime()
}
// The schedule an invoice's term gives it: each line's portion of the total and its discount, the last portion taking
// what rounding leaves; a term without lines is one portion due on the invoice's due date.
function plannedSchedule(invoice, total) {
    const currency = invoice.currencyUomId,
        lines = linesInEffect(invoice.settlementTermId, invoice.invoiceDate || ec.user.nowTimestamp)
    if (!lines.length)
        return [{scheduleSeqId: "01", dueDate: invoice.dueDate, amount: total, settlementTermId: invoice.settlementTermId}]
    let left = total
    return lines.map((line, index) => {
        const last = index === lines.length - 1
        const amount = last ? left : ec.l10n.roundCurrency(total.multiply(line.portionPercent).divide(100), currency)
        left = left.subtract(amount)
        const discount = toDecimal(line.discountPercent || 0)
        return {
            scheduleSeqId: String(index + 1).padStart(2, "0"),
            dueDate: addDays(invoice.invoiceDate, Number(line.daysBasis || 0)),
            amount,
            discountDate: discount.isZero() ? null : endOfDay(addDays(invoice.invoiceDate, Number(line.discountDays || 0))),
            discountAmount: discount.isZero() ? null : ec.l10n.roundCurrency(amount.multiply(discount).divide(100), currency),
            settlementTermId: invoice.settlementTermId,
            settlementTermLineId: line.settlementTermLineId
        }
    })
}
// Write an issued invoice's due schedule once (the InvoiceIssuedDueSchedule SECA): nothing for a credit memo, an invoice
// with no date or no total, or one that has its schedule.
function writeSchedule(p) {
    const invoice = one(I, {invoiceId: p.invoiceId})
    if (!invoice || !invoice.invoiceDate || invoice.invoiceTypeEnumId === "InvoiceCreditMemo") return {written: false}
    if (find(S, {invoiceId: p.invoiceId}).count() > 0) return {written: false}
    const total = lib.totals(invoice).invoiceTotal
    if (total.compare(0) <= 0) return {written: false}
    for (const row of plannedSchedule(invoice, total)) call("create#" + S, Object.assign({invoiceId: p.invoiceId}, row))
    return {written: true}
}
// A day as yyyy-MM-dd in the user's zone.
const day = value => (value == null ? null : ec.l10n.format(value, "yyyy-MM-dd"))
// An invoice's schedule rows (stored, else planned from its term without storing), each with its discount open on the
// day given; and the discount open on that day less prompt-payment discounts already credited.
function schedule(invoice, onDate = ec.user.nowTimestamp) {
    const stored = rows(S, {invoiceId: invoice.invoiceId}).sort((a, b) => a.scheduleSeqId.localeCompare(b.scheduleSeqId))
    const list = stored.length ? stored.map(lib.map) : plannedSchedule(invoice, lib.totals(invoice).invoiceTotal)
    const onDay = day(onDate)
    let open = toDecimal(0)
    const out = list.map(row => {
        const available = row.discountAmount != null && row.discountDate != null && onDay <= day(row.discountDate)
        if (available) open = open.add(row.discountAmount)
        return Object.assign({}, row, {
            dueDateText: day(row.dueDate),
            discountDateText: row.discountDate ? day(row.discountDate) : null,
            discountOpen: available
        })
    })
    const taken = rows(I, {creditForInvoiceId: invoice.invoiceId})
        .filter(row => row.statusId !== "InvoiceCancelled")
        .filter(row =>
            rows("mantle.account.invoice.InvoiceItem", {invoiceId: row.invoiceId}).some(
                item => item.itemTypeEnumId === "ItemPromptDiscount"
            )
        )
        .reduce((sum, row) => sum.add(lib.totals(row).invoiceTotal), toDecimal(0))
    const unpaid = lib.totals(invoice).unpaidTotal
    let discountAvailable = open.subtract(taken)
    if (discountAvailable.compare(0) < 0) discountAvailable = toDecimal(0)
    if (discountAvailable.compare(unpaid) > 0) discountAvailable = unpaid
    const openRows = out.filter(row => row.discountOpen)
    return {
        rows: out,
        stored: stored.length > 0,
        discountAvailable,
        discountDate: openRows.length ? openRows[0].discountDate : null,
        discountDateText: openRows.length ? openRows[0].discountDateText : null,
        nextDueDate: (out.find(row => day(row.dueDate) >= day(ec.user.nowTimestamp)) || out[out.length - 1])?.dueDate ?? null
    }
}
// The schedules of several invoices by invoice ID, for a page of open items or a run's selection.
function schedules(invoices, onDate = ec.user.nowTimestamp) {
    return Object.fromEntries(invoices.map(row => [row.invoiceId, schedule(row, onDate)]))
}
// The account a prompt-payment discount posts to: the organization's ItemPromptDiscount account for the side (outgoing
// for customer invoices, incoming for bills).
function discountAccount(organizationPartyId, receivable) {
    const found = call("mantle.ledger.InvoiceAutoPostServices.get#InvoiceItemGlAccount", {
        organizationPartyId,
        itemTypeEnumId: "ItemPromptDiscount",
        direction: receivable ? "O" : "I"
    })
    if (!found.glAccountId) denied("DISCOUNT_ACCOUNT_MISSING", "The prompt-payment discount account is not configured")
    return found.glAccountId
}
// The read service: an invoice's schedule for a user who may read it.
function dueSchedule(p) {
    const scope = lib.readInvoice(p)
    const out = schedule(scope.record, p.onDate || ec.user.nowTimestamp)
    return {
        scheduleRows: out.rows.map(row =>
            Object.assign(lib.display(row), {
                dueDateText: row.dueDateText,
                discountDateText: row.discountDateText,
                discountOpen: row.discountOpen
            })
        ),
        scheduleStored: out.stored,
        discountAvailable: out.discountAvailable,
        discountDateText: out.discountDateText
    }
}

const operations = {storeLines, termLines, writeSchedule, dueSchedule}
function execute(op, parameters) {
    if (!operations[op]) throw new Error("Unknown payment terms operation " + op)
    const result = operations[op](parameters)
    ec.context.putAll(result)
    return result
}
;({execute, lineDays, linesInEffect, schedule, schedules, discountAccount, day, endOfDay})
