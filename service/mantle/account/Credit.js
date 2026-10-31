// Customer credit (AC-11; mantle.account.CreditServices): the organization's policy for a customer in effect, the
// customer's exposure (unpaid invoices and open orders not yet invoiced, less unapplied payments and the payments authorized
// on the open orders), the check of an order on approval, which may put it on a Credit hold, the release of a credit hold
// with its decision, and the policy writers. An organization without a policy is never checked.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const {find, one, rows, call, denied, has} = lib
const POLICY = "mantle.account.billing.CustomerCreditPolicy"
const HOLD = "mantle.order.OrderHoldReason"
const OPEN_INVOICE_STATUSES = ["InvoiceFinalized", "InvoiceSent", "InvoiceAcked"]
const OPEN_ORDER_STATUSES = ["OrderPlaced", "OrderProcessing", "OrderApproved", "OrderHold", "OrderSent"]
const cf = () => ec.entity.conditionFactory
const today = () => ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
const startOf = day => ec.l10n.parseTimestamp(day + " 00:00:00", "yyyy-MM-dd HH:mm:ss")
const dayNumber = day => {
    const [year, month, date] = String(day).split("-").map(Number)
    return Date.UTC(year, month - 1, date) / 86400000
}
const money = (value, currency) => ec.l10n.formatCurrency(toDecimal(value ?? 0), currency)

// The policy in effect for a customer: its own row, else the organization's default (no customer).
function policyFor(organizationPartyId, customerPartyId, date = ec.user.nowTimestamp) {
    const dated = query =>
        query
            .condition(cf().makeConditionDate("fromDate", "thruDate", date))
            .orderBy("-fromDate")
            .limit(1)
            .list()
    const own = customerPartyId ? Array.from(dated(find(POLICY, {organizationPartyId, customerPartyId}))) : []
    if (own.length) return Object.assign(lib.map(own[0]), {source: "customer"})
    const fallback = Array.from(dated(find(POLICY, {organizationPartyId}).condition("customerPartyId", "is-null", null)))
    return fallback.length ? Object.assign(lib.map(fallback[0]), {source: "organization"}) : null
}

// What the customer owes and has committed to in one currency, each part summed in its query.
function exposure(organizationPartyId, customerPartyId, currencyUomId) {
    const summary = find("mantle.account.invoice.CollectionOverdueSummary", {
        fromPartyId: organizationPartyId,
        toPartyId: customerPartyId,
        currencyUomId
    })
        .condition("statusId", "in", OPEN_INVOICE_STATUSES)
        .condition("unpaidTotal", "greater", toDecimal(0))
    const unpaid = summary.selectField("overdueTotal").one()
    const overdue = find("mantle.account.invoice.CollectionOverdueSummary", {
        fromPartyId: organizationPartyId,
        toPartyId: customerPartyId,
        currencyUomId
    })
        .condition("statusId", "in", OPEN_INVOICE_STATUSES)
        .condition("unpaidTotal", "greater", toDecimal(0))
        .condition("dueDate", "less", startOf(today()))
        .selectField("overdueTotal")
        .selectField("oldestDueDate")
        .one()
    const parts = Array.from(
        find("mantle.order.OrderHeaderAndPart", {vendorPartyId: organizationPartyId, customerPartyId, currencyUomId})
            .condition("partStatusId", "in", OPEN_ORDER_STATUSES)
            .selectField("orderId")
            .selectField("orderPartSeqId")
            .selectField("partTotal")
            .limit(501)
            .list()
    )
    const incomplete = parts.length > 500
    const orderIds = [...new Set(parts.slice(0, 500).map(row => row.orderId))]
    let openOrders = toDecimal(0)
    for (const part of parts.slice(0, 500)) openOrders = openOrders.add(part.partTotal ?? 0)
    let billed = toDecimal(0),
        authorized = toDecimal(0)
    if (orderIds.length) {
        for (const billing of find("mantle.order.OrderItemBilling").condition("orderId", "in", orderIds).list())
            billed = billed.add(toDecimal(billing.quantity ?? 1).multiply(billing.amount ?? 0))
        for (const payment of find("mantle.account.payment.Payment", {statusId: "PmntAuthorized"})
            .condition("orderId", "in", orderIds)
            .list())
            authorized = authorized.add(payment.amount ?? 0)
    }
    const uninvoiced = openOrders.subtract(billed).compare(0) > 0 ? openOrders.subtract(billed) : toDecimal(0)
    const unapplied = find("mantle.account.payment.Payment", {
        fromPartyId: customerPartyId,
        toPartyId: organizationPartyId,
        amountUomId: currencyUomId
    })
        .condition("statusId", "in", ["PmntDelivered", "PmntConfirmed"])
        .condition("unappliedTotal", "greater", toDecimal(0))
        .list()
    const unappliedTotal = Array.from(unapplied).reduce((sum, row) => sum.add(row.unappliedTotal ?? 0), toDecimal(0))
    const round = value => ec.l10n.roundCurrency(value, currencyUomId)
    const total = round(
        toDecimal(unpaid?.overdueTotal ?? 0)
            .add(uninvoiced)
            .subtract(unappliedTotal)
            .subtract(authorized)
    )
    const oldestDay = overdue?.oldestDueDate ? lib.entityLib.bookDay(null, overdue.oldestDueDate) : null
    return {
        currencyUomId,
        unpaidInvoices: round(toDecimal(unpaid?.overdueTotal ?? 0)),
        overdueInvoices: round(toDecimal(overdue?.overdueTotal ?? 0)),
        openOrders: round(uninvoiced),
        unappliedPayments: round(unappliedTotal),
        authorizedPayments: round(authorized),
        exposure: total,
        oldestDueDate: oldestDay,
        overdueDays: oldestDay ? dayNumber(today()) - dayNumber(oldestDay) : 0,
        incomplete
    }
}

// The finding of a policy over an exposure: pass, or the policy's action with each reason.
function judge(policy, numbers, orderCurrency, customerName) {
    const reasons = []
    const currency = policy.currencyUomId
    if (orderCurrency && currency && orderCurrency !== currency)
        reasons.push({
            code: "CURRENCY_DIFFERENT",
            message: "the order is in " + orderCurrency + " and the credit limit in " + currency
        })
    if (policy.creditLimit != null && numbers.exposure.compare(policy.creditLimit) > 0)
        reasons.push({
            code: "CREDIT_LIMIT_EXCEEDED",
            message: "exposure " + money(numbers.exposure, currency) + " is over the limit " + money(policy.creditLimit, currency)
        })
    if (policy.overdueDaysLimit != null && numbers.overdueDays > Number(policy.overdueDaysLimit))
        reasons.push({
            code: "OVERDUE_LIMIT_EXCEEDED",
            message: "an invoice is " + numbers.overdueDays + " days overdue (limit " + policy.overdueDaysLimit + ")"
        })
    if (!reasons.length) return {resultEnumId: "pass", reasons, warning: null}
    const resultEnumId = policy.actionEnumId === "CpaHold" ? "hold" : "warn"
    return {
        resultEnumId,
        reasons,
        warning:
            "Credit " +
            (resultEnumId === "hold" ? "hold" : "warning") +
            " for " +
            customerName +
            ": " +
            reasons.map(row => row.message).join("; ")
    }
}

// The credit check of an order: its sales part (an internal organization selling to an outside customer) against the
// customer's policy. With placeHold, a Hold result puts the order on a Credit hold and notifies the organization's
// credit managers (CreditHoldRelease).
function evaluate(p) {
    const pass = {resultEnumId: "pass", reasons: [], warning: null, held: false}
    const header = one("mantle.order.OrderHeader", {orderId: p.orderId})
    if (!header) return pass
    const parts = rows("mantle.order.OrderPart", {orderId: p.orderId}).filter(
        part => !p.orderPartSeqId || part.orderPartSeqId === p.orderPartSeqId
    )
    const internal = partyId => !!partyId && !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
    const part = parts.find(row => internal(row.vendorPartyId) && row.customerPartyId && !internal(row.customerPartyId))
    if (!part) return pass
    const organizationPartyId = part.vendorPartyId,
        customerPartyId = part.customerPartyId
    const policy = policyFor(organizationPartyId, customerPartyId)
    if (!policy) return pass
    const currencyUomId = policy.currencyUomId || header.currencyUomId
    const numbers = exposure(organizationPartyId, customerPartyId, currencyUomId)
    // an order not yet counted as open (an approval of an order in another state) adds its own total
    if (!OPEN_ORDER_STATUSES.includes(part.statusId) && header.currencyUomId === currencyUomId)
        numbers.exposure = numbers.exposure.add(part.partTotal ?? header.grandTotal ?? 0)
    const names = lib.partyNames([customerPartyId])
    const finding = judge(policy, numbers, header.currencyUomId, names[customerPartyId] || customerPartyId)
    const out = Object.assign({}, finding, {
        held: false,
        orderHoldReasonId: null,
        organizationPartyId,
        customerPartyId,
        customerCreditPolicyId: policy.customerCreditPolicyId,
        creditLimit: policy.creditLimit,
        overdueDaysLimit: policy.overdueDaysLimit,
        currencyUomId,
        exposure: numbers.exposure,
        overdueDays: numbers.overdueDays
    })
    if (finding.resultEnumId !== "hold" || !p.placeHold) return out
    const placed = call("mantle.order.OrderServices.hold#Order", {
        orderId: p.orderId,
        orderPartSeqId: parts.length > 1 ? part.orderPartSeqId : null,
        holdTypeEnumId: "OhtCredit",
        holdComment: finding.warning.slice(0, 255)
    })
    out.held = true
    out.orderHoldReasonId = placed.orderHoldReasonId
    if (!placed.alreadyHeld)
        ec.resource.script("component://mr-mantle/service/mantle/account/Payables.js").execute("notify", {
            topic: "CreditHoldRelease",
            permission: "CREDIT_HOLD_RELEASE",
            organizationPartyId,
            recordEntityName: "mantle.order.OrderHeader",
            recordId: p.orderId,
            message: {
                orderId: p.orderId,
                organizationPartyId,
                customerPartyId,
                customerName: names[customerPartyId] || customerPartyId,
                exposure: String(numbers.exposure),
                creditLimit: policy.creditLimit == null ? null : String(policy.creditLimit),
                currencyUomId
            }
        })
    return out
}

// The sales part of a held order and its open credit hold, for a credit manager of its organization.
function heldOrder(p, permission) {
    const reasons = rows(HOLD, {orderId: p.orderId, holdTypeEnumId: "OhtCredit"}).filter(row => !row.releasedDate)
    const parts = rows("mantle.order.OrderPart", {orderId: p.orderId})
    const part = parts.find(row => one("mantle.party.PartyRole", {partyId: row.vendorPartyId, roleTypeId: "OrgInternal"}))
    if (!part) denied("ORDER_UNAVAILABLE", "The order is not available")
    lib.organization(part.vendorPartyId, permission)
    return {part, reason: reasons[0] || null, organizationPartyId: part.vendorPartyId, customerPartyId: part.customerPartyId}
}

// Release a credit hold with a reason: the decision is recorded with the exposure it was made on, the hold released
// (release#OrderHold, which approves the order when no other reason is open) and its notifications marked read.
function release(p) {
    const reasonText = String(p.reason || "").trim()
    if (!reasonText) denied("REASON_REQUIRED", "Give the reason for releasing the hold")
    const scope = heldOrder(p, "CREDIT_HOLD_RELEASE")
    if (!scope.reason) denied("HOLD_UNAVAILABLE", "The order has no open credit hold")
    const header = one("mantle.order.OrderHeader", {orderId: p.orderId})
    const policy = policyFor(scope.organizationPartyId, scope.customerPartyId)
    const currencyUomId = policy?.currencyUomId || header.currencyUomId
    const numbers = exposure(scope.organizationPartyId, scope.customerPartyId, currencyUomId)
    const decision = call("create#mantle.account.billing.CreditHoldDecision", {
        orderId: p.orderId,
        orderPartSeqId: scope.reason.orderPartSeqId || null,
        orderHoldReasonId: scope.reason.orderHoldReasonId,
        organizationPartyId: scope.organizationPartyId,
        customerPartyId: scope.customerPartyId,
        decisionEnumId: "CrdRelease",
        reason: reasonText.slice(0, 255),
        decidedByUserId: ec.user.userId,
        decidedDate: ec.user.nowTimestamp,
        expireDate: p.expireDate || null,
        exposureAmount: numbers.exposure,
        creditLimit: policy?.creditLimit ?? null,
        currencyUomId
    })
    call("update#" + HOLD, {orderHoldReasonId: scope.reason.orderHoldReasonId, sourceId: decision.creditHoldDecisionId})
    const released = call("mantle.order.OrderServices.release#OrderHold", {
        orderHoldReasonId: scope.reason.orderHoldReasonId,
        releaseComment: reasonText.slice(0, 255)
    })
    ec.resource.script("component://mr-mantle/service/mantle/account/Payables.js").execute("clearNotices", {
        topic: "CreditHoldRelease",
        recordEntityName: "mantle.order.OrderHeader",
        recordId: p.orderId
    })
    return {creditHoldDecisionId: decision.creditHoldDecisionId, statusId: released.statusId, stillHeld: released.stillHeld}
}

// A customer's credit for a reader: the policy in effect and its history, the exposure in its currency (the
// organization's base currency without one), what is left of the limit, the open credit holds and recent decisions.
function status(p) {
    const organizationPartyId = lib.organization(p.organizationPartyId, "CUSTOMER_CREDIT_VIEW")
    const customerPartyId = p.customerPartyId
    const customer = customerPartyId ? one("mantle.party.Party", {partyId: customerPartyId}) : null
    if (!customer || (customer.privateOwnerUserId && customer.privateOwnerUserId !== ec.user.userId))
        denied("CUSTOMER_UNAVAILABLE", "The customer is not available")
    const policy = policyFor(organizationPartyId, customerPartyId)
    const preference = lib.policy.preference(organizationPartyId)
    const currencyUomId = policy?.currencyUomId || preference.baseCurrencyUomId || null
    const numbers = currencyUomId ? exposure(organizationPartyId, customerPartyId, currencyUomId) : null
    const history = Array.from(find(POLICY, {organizationPartyId, customerPartyId}).orderBy("-fromDate").limit(20).list()).map(
        row => lib.display(row)
    )
    const holdRows = []
    const heldParts = Array.from(
        find("mantle.order.OrderHeaderAndPart", {vendorPartyId: organizationPartyId, customerPartyId, statusId: "OrderHold"})
            .selectField("orderId")
            .selectField("grandTotal")
            .selectField("currencyUomId")
            .limit(100)
            .list()
    )
    const heldIds = [...new Set(heldParts.map(row => row.orderId))]
    if (heldIds.length)
        for (const reason of find(HOLD, {holdTypeEnumId: "OhtCredit"})
            .condition("orderId", "in", heldIds)
            .condition("releasedDate", "is-null", null)
            .orderBy("placedDate")
            .list()) {
            const order = heldParts.find(row => row.orderId === reason.orderId)
            holdRows.push(
                Object.assign(lib.display(reason), {
                    grandTotal: order?.grandTotal ?? null,
                    currencyUomId: order?.currencyUomId ?? null
                })
            )
        }
    const decisions = Array.from(
        find("mantle.account.billing.CreditHoldDecision", {organizationPartyId, customerPartyId})
            .orderBy("-decidedDate")
            .limit(20)
            .list()
    ).map(row => lib.display(row))
    const available =
        policy?.creditLimit != null && numbers
            ? ec.l10n.roundCurrency(toDecimal(policy.creditLimit).subtract(numbers.exposure), currencyUomId)
            : null
    return {
        policy: policy ? lib.display(policy) : null,
        policyHistory: history,
        exposure: numbers,
        available,
        currencyUomId,
        holds: holdRows,
        decisions,
        canEditPolicy: has("ACCOUNTING_ADMIN") || has("CREDIT_HOLD_RELEASE"),
        canRelease: has("CREDIT_HOLD_RELEASE")
    }
}

// Store a customer's policy (or, isDefault, the organization's default): the row in effect ends and the next starts,
// unless nothing changed; ended ends it.
function store(p) {
    const isDefault = !!p.isDefault
    const organizationPartyId = lib.organization(p.organizationPartyId, isDefault ? "ACCOUNTING_ADMIN" : null)
    if (!isDefault && !has("ACCOUNTING_ADMIN") && !has("CREDIT_HOLD_RELEASE"))
        denied("PERMISSION_DENIED", "ACCOUNTING_ADMIN or CREDIT_HOLD_RELEASE authority is required")
    const customerPartyId = isDefault ? null : p.customerPartyId
    if (!isDefault) {
        const customer = customerPartyId ? one("mantle.party.Party", {partyId: customerPartyId}) : null
        if (!customer || (customer.privateOwnerUserId && customer.privateOwnerUserId !== ec.user.userId))
            denied("CUSTOMER_UNAVAILABLE", "The customer is not available")
    }
    const changeReason = String(p.changeReason || "").trim()
    if (!changeReason) denied("CHANGE_REASON_REQUIRED", "Give the reason for the change")
    const lockKey = {organizationPartyId}
    find("mantle.party.Party", {partyId: organizationPartyId}).forUpdate(true).one()
    let query = find(POLICY, lockKey).condition(cf().makeConditionDate("fromDate", "thruDate", ec.user.nowTimestamp))
    query = customerPartyId
        ? query.condition("customerPartyId", customerPartyId)
        : query.condition("customerPartyId", "is-null", null)
    const current = Array.from(query.list())
    const end = () => {
        for (const row of current)
            call("update#" + POLICY, {
                customerCreditPolicyId: row.customerCreditPolicyId,
                thruDate: ec.user.nowTimestamp,
                changeReason
            })
    }
    if (p.ended === "Y") {
        end()
        return {customerCreditPolicyId: null, changed: current.length > 0}
    }
    const preference = lib.policy.preference(organizationPartyId)
    const currencyUomId = p.currencyUomId || preference.baseCurrencyUomId
    if (!currencyUomId) denied("CURRENCY_REQUIRED", "Choose the currency of the limit")
    const actionEnumId = p.actionEnumId || "CpaHold"
    if (!["CpaWarn", "CpaHold"].includes(actionEnumId)) denied("ACTION_INVALID", "Choose warn or hold")
    let creditLimit = null
    if (p.creditLimit != null && p.creditLimit !== "") {
        creditLimit = toDecimal(p.creditLimit)
        if (creditLimit.compare(0) < 0) denied("LIMIT_INVALID", "The credit limit is not negative")
        creditLimit = ec.l10n.roundCurrency(creditLimit, currencyUomId)
    }
    let overdueDaysLimit = null
    if (p.overdueDaysLimit != null && p.overdueDaysLimit !== "") {
        overdueDaysLimit = Number(p.overdueDaysLimit)
        if (!Number.isInteger(overdueDaysLimit) || overdueDaysLimit < 0)
            denied("OVERDUE_DAYS_INVALID", "The overdue days are a whole number, not negative")
    }
    if (creditLimit == null && overdueDaysLimit == null) denied("POLICY_EMPTY", "Give a credit limit or overdue days")
    const same =
        current.length === 1 &&
        current[0].currencyUomId === currencyUomId &&
        current[0].actionEnumId === actionEnumId &&
        String(current[0].creditLimit ?? "") === String(creditLimit ?? "") &&
        String(current[0].overdueDaysLimit ?? "") === String(overdueDaysLimit ?? "")
    if (same) return {customerCreditPolicyId: current[0].customerCreditPolicyId, changed: false}
    end()
    const created = call("create#" + POLICY, {
        organizationPartyId,
        customerPartyId,
        currencyUomId,
        creditLimit,
        overdueDaysLimit,
        actionEnumId,
        fromDate: ec.user.nowTimestamp,
        changeReason,
        changedByUserId: ec.user.userId
    })
    return {customerCreditPolicyId: created.customerCreditPolicyId, changed: true}
}

const operations = {evaluate, release, status, store}
;({
    policyFor,
    exposure,
    execute(op, parameters) {
        if (!operations[op]) throw new Error("Unknown credit operation " + op)
        return operations[op](parameters)
    }
})
