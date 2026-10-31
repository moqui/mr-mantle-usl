// Accounting's customer and supplier pages, the PASS Billing and Supplier apps (impl-accounting P18): what a public page
// may read and do with an invoice or a purchase order. Every operation first finds the organization the page serves (the
// app mount's target on a published site) and checks the capability or the signed-in contact (ExternalAccess.check);
// it answers allow-listed projections, never Party, internal notes, costs or other parties' records. A refusal a page
// shows is a PASS error kind (NotFound, Unprocessable, Conflict, Unavailable, AuthenticationRequired).
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const access = ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js")
const apps = ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
const {find, one, rows, call} = lib
const I = lib.invoiceEntity,
    P = "mantle.account.payment.Payment",
    R = "mantle.account.method.PaymentGatewayResponse",
    SUB = "mantle.account.invoice.SupplierBillSubmission"
const issued = ["InvoiceFinalized", "InvoiceSent", "InvoiceAcked", "InvoicePmtRecvd"]
const fail = (kind, message) => {
    const error = new Error(message)
    error.moquiErrorKind = kind
    throw error
}
const unavailable = () => fail("NotFound", "This page is not available")
const text = value => (value == null ? null : String(value))
const day = value => (value == null ? null : lib.entityLib.dateText(value).slice(0, 10))
const money = (value, currencyUomId) => lib.entityLib.money(value, currencyUomId)
const moneyText = (value, currencyUomId) => ec.l10n.formatCurrency(money(value, currencyUomId), currencyUomId)
const name = partyId => {
    const org = partyId && one("mantle.party.Organization", {partyId})
    if (org) return org.organizationName || partyId
    const person = partyId && one("mantle.party.Person", {partyId})
    return person ? [person.firstName, person.lastName].filter(Boolean).join(" ") : ""
}
// The organization an app of a published site serves.
function served(siteId, app) {
    const site = siteId && one("mantle.public.PublicSite", {siteId})
    if (!site || site.state !== "published") unavailable()
    const mount = apps.mount(siteId, app)
    if (!mount?.targetId) unavailable()
    return mount.targetId
}
function operationId(p) {
    const value = String(p.operationId || "")
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(value)) fail("Unprocessable", "Reload the page and try again")
    return value
}

// ---- Billing: an invoice and its payment ----

function invoiceView(invoiceId) {
    const invoice = one(I, {invoiceId})
    const totals = lib.totals(invoice),
        currency = invoice.currencyUomId
    const lines = rows("mantle.account.invoice.InvoiceItem", {invoiceId})
        .sort((a, b) => String(a.invoiceItemSeqId).localeCompare(String(b.invoiceItemSeqId)))
        .map(line => ({
            description: line.description || "",
            quantity: text(line.quantity ?? 1),
            amountText: moneyText(line.amount ?? 0, currency),
            totalText: moneyText(lib.lineTotal(line, currency), currency)
        }))
    const paid = totals.invoiceTotal.subtract(totals.unpaidTotal)
    return {
        invoiceId,
        fromName: name(invoice.fromPartyId),
        toName: name(invoice.toPartyId),
        invoiceDateText: day(invoice.invoiceDate),
        dueDateText: day(invoice.dueDate),
        currencyUomId: currency,
        statusText: totals.unpaidTotal.compare(0) <= 0 ? "Paid" : "Open",
        lines,
        totalText: moneyText(totals.invoiceTotal, currency),
        paidText: moneyText(paid, currency),
        dueText: moneyText(totals.unpaidTotal, currency),
        due: text(money(totals.unpaidTotal, currency))
    }
}
// The organization's invoice payment gateway, when it has one bound and enabled.
function payGateway(organizationPartyId) {
    const gatewayId = lib.policy.preference(organizationPartyId).invoicePayGatewayConfigId
    if (!gatewayId) return null
    const binding = rows("mantle.account.method.PaymentGatewayOrganization", {
        organizationPartyId,
        paymentGatewayConfigId: gatewayId
    }).find(row => row.isEnabled !== "N" && lib.entityLib.active(row))
    return binding ? gatewayId : null
}
// The payment attempts of an invoice made through these pages: card payments from its customer through the gateway.
function attempts(invoice, gatewayId) {
    return rows(P, {forInvoiceId: invoice.invoiceId, fromPartyId: invoice.toPartyId, paymentInstrumentEnumId: "PiCreditCard"})
        .filter(row => !gatewayId || row.paymentGatewayConfigId === gatewayId)
        .sort((a, b) => lib.ms(b.lastUpdatedStamp) - lib.ms(a.lastUpdatedStamp))
}
const pending = row => ["PmntPromised", "PmntAuthorized"].includes(row.statusId)
function attemptView(payment) {
    const state = ["PmntDelivered", "PmntConfirmed"].includes(payment.statusId)
        ? "paid"
        : payment.statusId === "PmntDeclined"
          ? "declined"
          : pending(payment)
            ? "pending"
            : "failed"
    const latest = Array.from(find(R, {paymentId: payment.paymentId}).orderBy("-transactionDate").limit(10).list())
    const redirectUrl = state === "pending" ? latest.find(row => row.redirectUrl)?.redirectUrl || null : null
    return {
        attemptId: payment.paymentId,
        state,
        amountText: moneyText(payment.amount, payment.amountUomId),
        dateText: day(payment.effectiveDate),
        reference: state === "paid" ? payment.paymentRefNum || payment.paymentId : null,
        redirectUrl: redirectUrl && /^(https:\/\/|\/(?!\/))/.test(redirectUrl) ? redirectUrl : null,
        nextAction: state === "pending" ? (redirectUrl ? "continue" : "wait") : state === "paid" ? "none" : "retry"
    }
}
function checkInvoice(p, recordId = p.invoiceId) {
    const organizationPartyId = served(p.siteId, "billing")
    return access.check({token: p.token, scope: "InvoicePay", recordType: "Invoice", recordId, organizationPartyId})
}
function getInvoice(p) {
    const checked = checkInvoice(p)
    const invoice = one(I, {invoiceId: checked.recordId})
    const gatewayId = payGateway(checked.organizationPartyId)
    const open = attempts(invoice, gatewayId).find(pending)
    const view = invoiceView(invoice.invoiceId)
    return {
        invoice: view,
        attempt: open ? attemptView(open) : null,
        capabilities: {canPay: !!gatewayId && toDecimal(view.due).compare(0) > 0, canShare: checked.via === "contact"}
    }
}
// The invoices of the parties the signed-in user is a contact of, from the organization the site serves.
function findInvoices(p) {
    const organizationPartyId = served(p.siteId, "billing")
    if (!ec.user.userId) fail("AuthenticationRequired", "Sign in to see your invoices")
    const parties = access.contactParties()
    if (!parties.length) return {invoiceList: []}
    const list = Array.from(
        find(I)
            .condition("fromPartyId", organizationPartyId)
            .condition("toPartyId", "in", parties)
            .condition("statusId", "in", issued)
            .orderBy("-invoiceDate")
            .orderBy("invoiceId")
            .limit(50)
            .list()
    )
    return {
        invoiceList: list.map(row => {
            const view = invoiceView(row.invoiceId)
            return {
                invoiceId: row.invoiceId,
                toName: view.toName,
                invoiceDateText: view.invoiceDateText,
                dueDateText: view.dueDateText,
                totalText: view.totalText,
                dueText: view.dueText,
                statusText: view.statusText
            }
        })
    }
}
// A pay link to share: a contact gets a new capability for an invoice of a party they are a contact of. An internal user
// (send#Invoice) gets one with RECEIVABLE_EDIT in the invoice's organization, for each published Billing site of it.
function issueInvoiceAccess(p) {
    let organizationPartyId, siteId
    if (p.siteId) {
        const checked = checkInvoice(p)
        if (checked.via !== "contact") unavailable()
        organizationPartyId = checked.organizationPartyId
        siteId = p.siteId
    } else {
        organizationPartyId = access.requireIssuer("Invoice", p.invoiceId).organizationPartyId
        siteId = apps.sitesFor("billing", organizationPartyId)[0]
        if (!siteId) return {issued: false}
    }
    const created = access.create({recordType: "Invoice", recordId: p.invoiceId, scopes: "InvoicePay", validDays: 120})
    const url = apps.pageUrl(siteId, "billing", "/InvoicePay?token=" + encodeURIComponent(created.token))
    return {issued: !!url, capabilityId: created.capabilityId, token: created.token, url, expiresAt: created.thruDate}
}
// Look the gateway up for a pending attempt, then capture an authorized one: the outcome is the gateway's, never what the
// payer's browser carries back.
function refresh(payment) {
    if (!pending(payment) || !payment.paymentRefNum) return payment
    try {
        call("mantle.account.PaymentServices.get#SinglePaymentGatewayDetails", {paymentId: payment.paymentId})
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.warn("Invoice payment " + payment.paymentId + " lookup failed: " + String(error.message).split("\n")[0])
    }
    const after = one(P, {paymentId: payment.paymentId})
    if (after.statusId === "PmntAuthorized")
        call("mantle.account.PaymentServices.capture#SinglePayment", {
            paymentId: after.paymentId,
            operationKey: "pay-capture-" + after.paymentId
        })
    return one(P, {paymentId: payment.paymentId})
}
function startInvoicePayment(p) {
    const checked = checkInvoice(p)
    const key = operationId(p)
    if (!(p.confirm === true || p.confirm === "true")) fail("Unprocessable", "Confirm the payment")
    const gatewayId = payGateway(checked.organizationPartyId)
    if (!gatewayId) fail("Unavailable", "Payment is not available for this invoice")
    // one attempt at a time: the invoice is locked, a retry of the request answers its first result, and an attempt
    // still pending is resumed rather than paid twice
    let invoice = find(I, {invoiceId: checked.recordId}).forUpdate(true).one()
    const operation = lib.entityLib.operation({operationKey: key}, "InvoicePayStart", checked.organizationPartyId, {
        invoiceId: invoice.invoiceId
    })
    if (operation.old) return Object.assign(lib.previous(operation), {alreadyApplied: true})
    const open = attempts(invoice, gatewayId).find(pending)
    if (open) return {attempt: attemptView(refresh(open)), resumed: true}
    const due = lib.totals(invoice).unpaidTotal
    if (due.compare(0) <= 0) fail("Conflict", "Nothing is due on this invoice")
    const paymentId = call("mantle.account.PaymentServices.create#Payment", {
        fromPartyId: invoice.toPartyId,
        toPartyId: invoice.fromPartyId,
        paymentTypeEnumId: "PtInvoicePayment",
        paymentInstrumentEnumId: "PiCreditCard",
        paymentGatewayConfigId: gatewayId,
        forInvoiceId: invoice.invoiceId,
        amount: money(due, invoice.currencyUomId),
        amountUomId: invoice.currencyUomId,
        statusId: "PmntPromised",
        effectiveDate: ec.user.nowTimestamp,
        comments: "Paid from the invoice's Billing page"
    }).paymentId
    const returnUrl = apps.pageUrl(p.siteId, "billing", "/InvoicePay/return?attemptId=" + encodeURIComponent(paymentId))
    const auth = call("mantle.account.PaymentServices.authorize#SinglePayment", {
        paymentId,
        operationKey: "pay-auth-" + paymentId,
        returnUrl
    })
    let payment = one(P, {paymentId})
    const response = auth.paymentGatewayResponseId && one(R, {paymentGatewayResponseId: auth.paymentGatewayResponseId})
    // a pending answer keeps its reference, which the gateway's details service looks up
    if (pending(payment) && response?.referenceNum && !payment.paymentRefNum)
        call("update#" + P, {paymentId, paymentRefNum: response.referenceNum})
    if (payment.statusId === "PmntAuthorized")
        call("mantle.account.PaymentServices.capture#SinglePayment", {paymentId, operationKey: "pay-capture-" + paymentId})
    payment = one(P, {paymentId})
    const result = {attempt: attemptView(payment), resumed: false}
    lib.complete(operation, P, paymentId, result)
    return result
}
function getPaymentResult(p) {
    const payment = p.attemptId && one(P, {paymentId: p.attemptId})
    if (!payment?.forInvoiceId) unavailable()
    const checked = checkInvoice(p, payment.forInvoiceId)
    const invoice = one(I, {invoiceId: checked.recordId})
    if (!attempts(invoice, null).some(row => row.paymentId === payment.paymentId)) unavailable()
    find(P, {paymentId: payment.paymentId}).forUpdate(true).one()
    const after = refresh(one(P, {paymentId: payment.paymentId}))
    return {attempt: attemptView(after), invoice: invoiceView(invoice.invoiceId)}
}

// ---- Supplier: a purchase order's bill ----

const billTypes = ["application/pdf", "image/png", "image/jpeg"]
function checkOrder(p) {
    const organizationPartyId = served(p.siteId, "supplier")
    return access.check({token: p.token, scope: "BillUpload", recordType: "Order", recordId: p.orderId, organizationPartyId})
}
function orderView(orderId) {
    const order = one("mantle.order.OrderHeader", {orderId})
    return {
        orderId,
        orderName: order.orderName || null,
        placedDateText: day(order.placedDate || order.entryDate),
        totalText: order.grandTotal == null ? null : moneyText(order.grandTotal, order.currencyUomId),
        currencyUomId: order.currencyUomId
    }
}
function submissionView(row) {
    const invoice = row.invoiceId && one(I, {invoiceId: row.invoiceId})
    const state = !invoice
        ? "Received"
        : invoice.statusId === "InvoiceCancelled"
          ? "Not accepted"
          : ["InvoiceIncoming", "InvoiceReceived"].includes(invoice.statusId)
            ? "Received for review"
            : "Accepted for payment"
    return {
        submissionId: row.submissionId,
        orderId: row.orderId,
        referenceNumber: row.referenceNumber,
        billReference: row.invoiceId,
        receivedDateText: lib.entityLib.dateText(row.receivedDate),
        filename: row.filename,
        stateText: state
    }
}
function submissions(checked) {
    return Array.from(
        find(SUB, {organizationPartyId: checked.organizationPartyId, supplierPartyId: checked.partyId, orderId: checked.recordId})
            .orderBy("-receivedDate")
            .limit(20)
            .list()
    ).map(submissionView)
}
function getSubmission(p) {
    const checked = checkOrder(p)
    const list = submissions(checked)
    let submission = null
    if (p.submissionId) {
        submission = list.find(row => row.submissionId === p.submissionId) || null
        if (!submission) unavailable()
    }
    return {order: orderView(checked.recordId), submissionList: list, submission}
}
// Stage the file under PASS's media root and scan it, as Forum stages an attachment; refuse it unless it is clean.
function stage(file) {
    const maxBytes = 10485760
    if (!file || Number(file.size) < 1 || Number(file.size) > maxBytes) fail("Unprocessable", "Attach the bill, at most 10 MB")
    const type = String(file.contentType || "")
    if (!billTypes.includes(type)) fail("Unprocessable", "Attach the bill as a PDF, PNG or JPEG file")
    const scanner = System.getProperty("pass_scanner_service"),
        root = System.getProperty("pass_media_root")
    if (!scanner || !root) fail("Unavailable", "Bill files cannot be received now")
    const location = String(root).replace(/\/$/, "") + "/bills/" + ec.user.randomString(32)
    file.write(location)
    let clean = false
    try {
        clean = ec.service.sync().throwOnError(true).name(scanner).parameters({location, mimeType: type}).call().clean === true
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.error("Supplier bill file at " + location + " could not be scanned; refused")
    }
    if (!clean) {
        ec.resource.getLocationReference(location).delete()
        fail("Unprocessable", "The file could not be accepted; send another copy")
    }
    return {
        location,
        filename: String(file.name || "bill").replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 100),
        byteSize: Number(file.size)
    }
}
function submitSupplierBill(p) {
    const checked = checkOrder(p)
    const key = operationId(p)
    // the organization first, as import#Bill locks it, so two submissions of one reference are serialized
    find("mantle.party.Party", {partyId: checked.organizationPartyId}).forUpdate(true).one()
    const scope = {organizationPartyId: checked.organizationPartyId, supplierPartyId: checked.partyId}
    const repeat = rows(SUB, {...scope, operationId: key})[0]
    if (repeat) return {submission: submissionView(repeat), alreadyApplied: true}
    const reference = String(p.referenceNumber || "").trim()
    if (!reference || reference.length > 60) fail("Unprocessable", "Enter your bill number")
    const earlier = rows(SUB, {...scope, referenceNumber: reference})[0]
    if (earlier) return {submission: submissionView(earlier), alreadyApplied: true}
    const order = one("mantle.order.OrderHeader", {orderId: checked.recordId})
    let amount = null
    if (p.amount != null && String(p.amount).trim() !== "")
        try {
            amount = lib.amount(p.amount, order.currencyUomId)
        } catch (error) {
            fail("Unprocessable", "Enter the bill's amount in " + order.currencyUomId)
        }
    const staged = stage(p.file)
    let imported
    try {
        imported = ec.resource
            .script("component://mr-mantle/service/mantle/account/Payables.js")
            .execute("portalBill", {
                ...scope,
                referenceNumber: reference,
                invoiceDate: p.invoiceDate ? new Date(lib.ms(p.invoiceDate)) : null,
                amount,
                currencyUomId: order.currencyUomId,
                orderId: checked.recordId,
                orderPartSeqId: checked.orderPartSeqId,
                description: "Bill " + reference + " for order " + checked.recordId,
                stagedLocation: staged.location,
                stagedFilename: staged.filename,
                fileDescription: "Supplier bill " + reference
            })
    } catch (error) {
        if (lib.entityLib.reasonCode(error) === "BILL_DUPLICATE")
            fail("Conflict", "Bill " + reference + " was already received; contact the buyer if it needs a change")
        throw error
    } finally {
        try {
            ec.resource.getLocationReference(staged.location).delete()
        } catch (error) {
            ec.logger.warn("Staged supplier bill file " + staged.location + " was not removed")
        }
    }
    const row = call("create#" + SUB, {
        ...scope,
        orderId: checked.recordId,
        capabilityId: checked.capabilityId,
        operationId: key,
        referenceNumber: reference,
        invoiceId: imported.invoiceId,
        attached: imported.attached ? "Y" : "N",
        filename: staged.filename,
        byteSize: staged.byteSize,
        receivedDate: ec.user.nowTimestamp,
        submittedByUserId: ec.user.userId
    })
    return {submission: submissionView(one(SUB, {submissionId: row.submissionId})), alreadyApplied: false}
}

// ---- Readiness of a site's Billing or Supplier app ----

function appReadiness(p) {
    const checks = [{name: "organization", ready: !!p.targetId && apps.targets.organization(p.targetId)}]
    if (p.app === "billing")
        checks.push({name: "payment gateway", ready: !!p.targetId && checks[0].ready && !!payGateway(p.targetId)})
    if (p.app === "supplier")
        checks.push({
            name: "bill scanning",
            ready: !!System.getProperty("pass_scanner_service") && !!System.getProperty("pass_media_root")
        })
    checks.push({name: "canonical host", ready: !!apps.pageUrl(p.siteId, p.app, "/")})
    return {checks}
}

const operations = {
    getInvoice,
    findInvoices,
    issueInvoiceAccess,
    startInvoicePayment,
    getPaymentResult,
    getSubmission,
    submitSupplierBill,
    appReadiness
}
;({
    execute(op, input) {
        if (!operations[op]) fail("NotFound", "Unknown portal operation")
        // the checks above are this module's; Mantle's reads and writes below them run without artifact authorization
        const was = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](input || {})
        } finally {
            if (!was) ec.artifactExecution.enableAuthz()
        }
    }
})
