// Payables over Mantle's invoice services: the bills queue of an organization, a supplier bill's intake (import#Bill)
// and a bill or invoice from its order (create#InvoiceFromSource). The checks are the side's permission and the
// organization the user works in (InvoiceWorkflowLib), as for receivables.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const {find, one, rows, call, denied, has} = lib
const I = lib.invoiceEntity
const dayMs = 86400000
const queues = ["incoming", "review", "held", "approved", "due", "credits", "expenses", "all"]

// The bills of an organization the user may read: its supplier bills, the linked credits of its bills and supplier
// credits, private counterparties of other users left out, filtered in the query.
function payableQuery(p) {
    if (!has("ACCOUNTING_VIEW") && !has("ACCOUNTING_ADMIN")) lib.requirePermission("PAYABLE_VIEW")
    const organizationPartyId = lib.organization(p.organizationPartyId || lib.policy.access().activeOrganizationPartyId)
    const cf = ec.entity.conditionFactory
    const all = conditions => cf.makeCondition(conditions, "and")
    let query = find("mantle.account.invoice.InvoiceFinance").condition(
        cf.makeCondition(
            [
                all([
                    cf.makeCondition("toPartyId", "equals", organizationPartyId),
                    cf.makeCondition("creditForInvoiceId", "is-null", null),
                    cf.makeCondition("financeDirection", "is-null", null)
                ]),
                all([
                    cf.makeCondition("sourceToPartyId", "equals", organizationPartyId),
                    cf.makeCondition("financeDirection", "is-null", null)
                ]),
                all([
                    cf.makeCondition("financeOrganizationPartyId", "equals", organizationPartyId),
                    cf.makeCondition("financeDirection", "equals", "payable")
                ])
            ],
            "or"
        )
    )
    if (!lib.access.systemAdmin())
        for (const field of ["fromPrivateOwnerUserId", "toPrivateOwnerUserId"])
            query = query.condition(
                cf.makeCondition(
                    [cf.makeCondition(field, "is-null", null), cf.makeCondition(field, "equals", ec.user.userId)],
                    "or"
                )
            )
    if (p.supplierPartyId)
        query = query.condition(
            cf.makeCondition(
                [
                    cf.makeCondition("fromPartyId", "equals", p.supplierPartyId),
                    cf.makeCondition("toPartyId", "equals", p.supplierPartyId)
                ],
                "or"
            )
        )
    if (p.recordId || p.invoiceId) query = query.condition("invoiceId", p.recordId || p.invoiceId)
    if (p.text)
        query = query.condition(
            cf.makeCondition(
                ["invoiceId", "description", "referenceNumber"].map(field =>
                    cf.makeCondition(field, "like", "%" + p.text + "%").ignoreCase()
                ),
                "or"
            )
        )
    if (p.statusId) query = query.condition("statusId", p.statusId)
    if (p.invoiceTypeEnumId) query = query.condition("invoiceTypeEnumId", p.invoiceTypeEnumId)
    if (p.currencyUomId) query = query.condition("currencyUomId", p.currencyUomId)
    for (const [input, field, op] of [
        ["fromDate", "invoiceDate", "greater-equals"],
        ["thruDate", "invoiceDate", "less"],
        ["dueFromDate", "dueDate", "greater-equals"],
        ["dueThruDate", "dueDate", "less"]
    ])
        if (p[input]) query = query.condition(field, op, p[input])
    const queue = p.queue || "all"
    if (!queues.includes(queue)) denied("QUEUE_INVALID", "Unknown bills queue")
    if (queue === "incoming") query = query.condition("statusId", "InvoiceIncoming")
    else if (queue === "review") query = query.condition("statusId", "InvoiceReceived")
    else if (queue === "held") query = query.condition("invoiceId", "in", heldInvoiceIds(organizationPartyId))
    else if (queue === "credits") query = query.condition("invoiceTypeEnumId", "InvoiceCreditMemo")
    else if (queue === "expenses") query = query.condition("fromPartyTypeEnumId", "PtyPerson")
    else if (["approved", "due"].includes(queue)) {
        query = query.condition("statusId", "InvoiceApproved").condition("unpaidTotal", "greater", 0)
        if (queue === "due") query = query.condition("dueDate", "less", new Date(Number(ec.user.nowTimestamp) + 7 * dayMs))
    }
    return {query, organizationPartyId}
}
// The bills of the organization with an open hold, at most 1000.
function heldInvoiceIds(organizationPartyId) {
    const ids = Array.from(
        find("mantle.account.invoice.InvoiceHoldDetail", {toPartyId: organizationPartyId})
            .condition("releasedDate", "is-null", null)
            .selectField("invoiceId")
            .distinct(true)
            .limit(1000)
            .list()
    ).map(row => row.invoiceId)
    return ids.length ? ids : ["_NONE_"]
}
function statusNames(ids) {
    const wanted = [...new Set(ids.filter(Boolean))]
    if (!wanted.length) return {}
    return Object.fromEntries(
        Array.from(find("moqui.basic.StatusItem").condition("statusId", "in", wanted).list()).map(row => [
            row.statusId,
            row.description || row.statusId
        ])
    )
}
// Rows for a screen: display values, stored totals, party and status names and the open holds' reasons.
function payableRows(records) {
    const names = lib.partyNames(records.flatMap(row => [row.toPartyId, row.fromPartyId]))
    const statuses = statusNames(records.map(row => row.statusId))
    const holds = lib.openHolds(records.map(row => row.invoiceId))
    const reasonIds = [...new Set(Object.values(holds).flatMap(list => list.map(row => row.holdReasonEnumId)))]
    const reasons = reasonIds.length
        ? Object.fromEntries(
              Array.from(find("moqui.basic.Enumeration").condition("enumId", "in", reasonIds).list()).map(row => [
                  row.enumId,
                  row.description
              ])
          )
        : {}
    return records.map(row =>
        Object.assign(lib.invoiceDisplay(row), lib.storedTotals(row), {
            toName: names[row.toPartyId],
            fromName: names[row.fromPartyId],
            statusDescription: statuses[row.statusId] || row.statusId,
            isHeld: !!holds[row.invoiceId],
            holdText: (holds[row.invoiceId] || []).map(hold => reasons[hold.holdReasonEnumId] || hold.holdReasonEnumId).join(", ")
        })
    )
}
function payables(p) {
    const {query} = payableQuery(p)
    const result = lib.page(query.orderBy("-invoiceDate,invoiceId"), p, "records", payableQuery(p).query.count())
    result.rows = payableRows(result.rows)
    result.records = result.rows
    return result
}

// A supplier party for a bill: it exists and no other user keeps it private.
function supplier(partyId) {
    const party = partyId && one("mantle.party.Party", {partyId})
    if (!party || (party.privateOwnerUserId && party.privateOwnerUserId !== ec.user.userId && !lib.access.systemAdmin()))
        denied("SUPPLIER_UNAVAILABLE", "Choose an available supplier")
    return party
}
// The self-billed draft of a receipt: the open bill its shipment's receipts were billed on.
function selfBilledDraft(organizationPartyId, supplierPartyId, shipmentId) {
    const shipment = one("mantle.shipment.Shipment", {shipmentId})
    if (!shipment || shipment.toPartyId !== organizationPartyId || shipment.fromPartyId !== supplierPartyId)
        denied("SHIPMENT_INVALID", "Choose a receipt from this supplier to this organization")
    const ids = [
        ...new Set(
            Array.from(
                find("mantle.shipment.ShipmentItemSource", {shipmentId}).condition("invoiceId", "is-not-null", null).list()
            ).map(row => row.invoiceId)
        )
    ]
    if (!ids.length) return null
    return Array.from(
        find(I)
            .condition("invoiceId", "in", ids)
            .condition("toPartyId", organizationPartyId)
            .condition("statusId", "in", ["InvoiceIncoming", "InvoiceReceived"])
            .orderBy("invoiceId")
            .list()
    )[0]
}
function attach(invoiceId, p) {
    if (!p.contentFile) return null
    return call("mantle.account.InvoiceServices.create#InvoiceContent", {
        invoiceId,
        contentFile: p.contentFile,
        description: p.fileDescription || "Supplier bill",
        contentDate: ec.user.nowTimestamp,
        userId: ec.user.userId
    }).invoiceContentId
}
// import#Bill: a supplier's bill, keyed by organization, supplier and the supplier's reference; a repeat is refused and the
// earlier bill named. For a receipt with a self-billed draft the file is attached to that draft instead.
function importBill(p) {
    lib.requirePermission("PAYABLE_IMPORT")
    const organizationPartyId = lib.organization(p.organizationPartyId, null, true)
    supplier(p.supplierPartyId)
    const reference = String(p.referenceNumber || "").trim()
    const request = {
        organizationPartyId,
        supplierPartyId: p.supplierPartyId,
        referenceNumber: reference,
        shipmentId: p.shipmentId || null,
        amount: p.amount == null ? null : String(p.amount)
    }
    const operation = p.operationKey ? lib.operation(p, "BillImport", organizationPartyId, request, false) : null
    if (operation?.old) return lib.previous(operation)
    let result = null
    if (p.shipmentId) {
        const draft = selfBilledDraft(organizationPartyId, p.supplierPartyId, p.shipmentId)
        if (draft) {
            if (reference && !draft.referenceNumber) call("update#" + I, {invoiceId: draft.invoiceId, referenceNumber: reference})
            result = {invoiceId: draft.invoiceId, attached: true, invoiceContentId: attach(draft.invoiceId, p)}
        }
    }
    if (!result) {
        if (!reference) denied("REFERENCE_REQUIRED", "Enter the supplier's bill reference")
        const earlier = Array.from(
            find(I, {toPartyId: organizationPartyId, fromPartyId: p.supplierPartyId, referenceNumber: reference})
                .condition("statusId", "not-equals", "InvoiceCancelled")
                .orderBy("invoiceId")
                .list()
        )[0]
        if (earlier)
            denied("BILL_DUPLICATE", "Bill " + reference + " from this supplier is already recorded as " + earlier.invoiceId)
        if (p.orderId) {
            const part = one("mantle.order.OrderPart", {orderId: p.orderId, orderPartSeqId: p.orderPartSeqId || "01"})
            if (!part || part.customerPartyId !== organizationPartyId || part.vendorPartyId !== p.supplierPartyId)
                denied("ORDER_INVALID", "Choose an order of this organization from this supplier")
        }
        const created = call("mantle.account.InvoiceServices.create#Invoice", {
            fromPartyId: p.supplierPartyId,
            toPartyId: organizationPartyId,
            invoiceTypeEnumId: p.invoiceTypeEnumId || "InvoiceSales",
            currencyUomId: p.currencyUomId || lib.policy.preference(organizationPartyId).baseCurrencyUomId,
            invoiceDate: p.invoiceDate || ec.user.nowTimestamp,
            referenceNumber: reference,
            description: p.description || (p.orderId ? "Bill for order " + p.orderId : "Supplier bill " + reference)
        })
        if (p.amount != null && toDecimal(p.amount).compare(0) > 0)
            call("mantle.account.InvoiceServices.create#InvoiceItem", {
                invoiceId: created.invoiceId,
                itemTypeEnumId: p.itemTypeEnumId || "ItemExpense",
                quantity: "1",
                amount: ec.l10n.roundCurrency(toDecimal(p.amount), one(I, {invoiceId: created.invoiceId}).currencyUomId),
                description: p.description || "Supplier bill " + reference
            })
        result = {invoiceId: created.invoiceId, attached: false, invoiceContentId: attach(created.invoiceId, p)}
    }
    if (operation) lib.complete(operation, I, result.invoiceId, result)
    return result
}

// create#InvoiceFromSource: the bill of a purchase order part (or the invoice of a sales order part) on the ordered basis
// (create#EntireOrderPartInvoice) or, for a purchase, the received basis (create#PurchaseShipmentInvoices with
// acceptedOnly). The order's payments are marked for the invoice, so they apply when it is approved. A second invoice of
// the same source is refused and the first named.
function invoiceFromSource(p) {
    const part = one("mantle.order.OrderPart", {orderId: p.orderId, orderPartSeqId: p.orderPartSeqId || "01"})
    const header = part && one("mantle.order.OrderHeader", {orderId: p.orderId})
    if (!part || !header) denied("ORDER_UNAVAILABLE", "Order is not available")
    const internal = partyId => !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
    const payable = internal(part.customerPartyId) && !internal(part.vendorPartyId)
    const organizationPartyId = payable ? part.customerPartyId : part.vendorPartyId
    if (p.organizationPartyId && p.organizationPartyId !== organizationPartyId)
        denied("ORGANIZATION_DENIED", "The order belongs to another organization")
    lib.organization(organizationPartyId, payable ? "PAYABLE_EDIT" : "RECEIVABLE_EDIT", true)
    supplier(payable ? part.vendorPartyId : part.customerPartyId)
    if (!["OrderApproved", "OrderSent", "OrderProcessing", "OrderCompleted"].includes(header.statusId))
        denied("ORDER_STATE_INVALID", "Only an approved order is invoiced")
    const basis = p.basis || "ordered"
    if (!["ordered", "received"].includes(basis)) denied("SOURCE_BASIS_INVALID", "Choose the ordered or the received basis")
    if (basis === "received" && !payable) denied("SOURCE_BASIS_INVALID", "Only a purchase is billed on its receipts")
    const sourceKey = ["source", p.orderId, part.orderPartSeqId, basis, p.shipmentId || ""].join(":")
    const earlier = Array.from(
        find(I, {workflowSourceKey: sourceKey}).condition("statusId", "not-equals", "InvoiceCancelled").list()
    )[0]
    if (earlier) denied("SOURCE_ALREADY_INVOICED", "This source is already invoiced as " + earlier.invoiceId)
    const operation = p.operationKey ? lib.operation(p, "InvoiceFromSource", organizationPartyId, {sourceKey}, false) : null
    if (operation?.old) return lib.previous(operation)
    const invoiceDate = p.invoiceDate || ec.user.nowTimestamp
    let invoiceIdList = []
    if (basis === "ordered") {
        if (!unbilledItems(p.orderId, part.orderPartSeqId))
            denied("NOTHING_TO_BILL", "Every line of this order is already invoiced")
        invoiceIdList = [
            call("mantle.account.InvoiceServices.create#EntireOrderPartInvoice", {
                orderId: p.orderId,
                orderPartSeqId: part.orderPartSeqId,
                invoiceDate
            }).invoiceId
        ]
    } else {
        const shipmentIds = p.shipmentId ? [p.shipmentId] : deliveredShipments(p.orderId)
        for (const shipmentId of shipmentIds) {
            const shipment = one("mantle.shipment.Shipment", {shipmentId})
            if (!shipment || shipment.toPartyId !== organizationPartyId || shipment.statusId !== "ShipDelivered")
                denied("SHIPMENT_INVALID", "Choose a delivered receipt of this order")
            const made = call("mantle.account.InvoiceServices.create#PurchaseShipmentInvoices", {
                shipmentId,
                invoiceDate,
                acceptedOnly: true
            })
            invoiceIdList.push(...Array.from(made.invoiceIdList || []))
        }
        invoiceIdList = invoiceIdList.filter(invoiceId => find("mantle.account.invoice.InvoiceItem", {invoiceId}).count() > 0)
        if (!invoiceIdList.length) denied("NOTHING_TO_BILL", "No accepted receipt of this order is left to bill")
    }
    for (const invoiceId of invoiceIdList) call("update#" + I, {invoiceId, workflowSourceKey: sourceKey})
    const result = {invoiceId: invoiceIdList[0], invoiceIdList}
    if (operation) lib.complete(operation, I, result.invoiceId, result)
    return result
}
function unbilledItems(orderId, orderPartSeqId) {
    let count = 0
    for (const item of rows("mantle.order.OrderItem", {orderId, orderPartSeqId})) {
        const billed = rows("mantle.order.OrderItemBilling", {orderId, orderItemSeqId: item.orderItemSeqId}).reduce(
            (sum, row) => sum.add(row.quantity ?? 0),
            toDecimal(0)
        )
        if (toDecimal(item.quantity ?? 1).compare(billed) > 0) count++
    }
    return count
}
function deliveredShipments(orderId) {
    const ids = [
        ...new Set(Array.from(find("mantle.shipment.ShipmentItemSource", {orderId}).list()).map(row => row.shipmentId))
    ].filter(Boolean)
    if (!ids.length) return []
    return Array.from(
        find("mantle.shipment.Shipment").condition("shipmentId", "in", ids).condition("statusId", "ShipDelivered").list()
    ).map(row => row.shipmentId)
}

// The holds of a bill, newest first, with their reason and user names, and what the user may do with the bill's holds
// and approval.
function holds(p) {
    const scope = lib.readInvoice(p)
    const record = scope.record
    const list = Array.from(
        find("mantle.account.invoice.InvoiceHold", {invoiceId: record.invoiceId}).orderBy("-placedDate").list()
    )
    const userIds = [
        ...new Set(list.flatMap(row => [row.placedByUserId, row.releasedByUserId, row.releaseRequestedByUserId]).filter(Boolean))
    ]
    const users = userIds.length
        ? Object.fromEntries(
              Array.from(find("moqui.security.UserAccount").condition("userId", "in", userIds).list()).map(row => [
                  row.userId,
                  row.userFullName || row.username
              ])
          )
        : {}
    const reasons = Object.fromEntries(
        rows("moqui.basic.Enumeration", {enumTypeId: "InvoiceHoldReason"}).map(row => [row.enumId, row.description])
    )
    const me = ec.user.userId
    const open = list.filter(row => !row.releasedDate)
    const draft = ["InvoiceIncoming", "InvoiceReceived", "InvoiceInProcess"].includes(record.statusId)
    const payable = !scope.receivable
    const holdRows = list.map(row => ({
        invoiceHoldId: row.invoiceHoldId,
        holdReasonEnumId: row.holdReasonEnumId,
        reasonText: reasons[row.holdReasonEnumId] || row.holdReasonEnumId,
        holdComment: row.holdComment,
        reviewDateText: lib.policy.dateText(row.reviewDate),
        placedByName: users[row.placedByUserId] || row.placedByUserId,
        placedDateText: lib.policy.dateText(row.placedDate),
        releaseRequestedByName: users[row.releaseRequestedByUserId] || "",
        releaseRequestedDateText: lib.policy.dateText(row.releaseRequestedDate),
        releaseRequestNote: row.releaseRequestNote,
        releasedByName: users[row.releasedByUserId] || "",
        releasedDateText: lib.policy.dateText(row.releasedDate),
        releaseComment: row.releaseComment,
        isOpen: !row.releasedDate,
        placedByMe: row.placedByUserId === me,
        canRelease: !row.releasedDate && row.placedByUserId !== me && has("INVOICE_HOLD_RELEASE"),
        canRequestRelease: !row.releasedDate && !row.releaseRequestedDate && has("PAYABLE_EDIT")
    }))
    return {
        holdRows,
        openHoldCount: open.length,
        payableCapabilities: {
            payable,
            canHold: payable && has("INVOICE_HOLD") && !["InvoiceCancelled", "InvoicePmtSent"].includes(record.statusId),
            canApprove: payable && draft && !open.length && has("INVOICE_APPROVE"),
            canRequestApproval: payable && record.statusId === "InvoiceIncoming" && has("PAYABLE_EDIT")
        }
    }
}

// A supplier's bills and payments with an organization, by currency: the open payable (approved and unpaid), the part
// of it on hold, and what is overdue. Bills beyond the first 500 make the summary incomplete.
function supplierSummary(p) {
    const bills = Array.from(
        find(I, {toPartyId: p.organizationPartyId, fromPartyId: p.supplierPartyId})
            .condition("statusId", "not-in", ["InvoiceCancelled"])
            .condition("unpaidTotal", "greater", 0)
            .limit(501)
            .list()
    )
    const holds = lib.openHolds(bills.map(row => row.invoiceId))
    const now = Number(ec.user.nowTimestamp)
    const byCurrency = {}
    for (const bill of bills.slice(0, 500)) {
        const row =
            byCurrency[bill.currencyUomId] ||
            (byCurrency[bill.currencyUomId] = {
                currencyUomId: bill.currencyUomId,
                openPayable: toDecimal(0),
                inReview: toDecimal(0),
                heldTotal: toDecimal(0),
                overdue: toDecimal(0)
            })
        const unpaid = toDecimal(bill.unpaidTotal ?? 0)
        if (["InvoiceIncoming", "InvoiceReceived"].includes(bill.statusId)) row.inReview = row.inReview.add(unpaid)
        else row.openPayable = row.openPayable.add(unpaid)
        if (holds[bill.invoiceId]) row.heldTotal = row.heldTotal.add(unpaid)
        if (bill.statusId === "InvoiceApproved" && bill.dueDate && Number(bill.dueDate) < now)
            row.overdue = row.overdue.add(unpaid)
    }
    return {summaryRows: Object.values(byCurrency), incomplete: bills.length > 500}
}

const operations = {payables, importBill, invoiceFromSource, holds, supplierSummary}
;({
    execute: (op, parameters) => {
        if (!operations[op]) denied("OPERATION_UNKNOWN", "Unknown payables operation " + op)
        return operations[op](parameters)
    }
})
