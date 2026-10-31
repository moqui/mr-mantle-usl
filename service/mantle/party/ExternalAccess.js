// External access (CX-PORTALS): one record of an organization for an outside party, reached through a bearer token or
// by a signed-in contact of that party. The record types are listed here with the permission an internal user needs to
// issue or revoke their capabilities; an app's Mantle services (PortalServices, and later Purchasing's and Customer
// Service's) call check() first and keep no token rules of their own. Deny by default: an unknown record type, scope,
// expired, revoked or foreign token is unavailable, and says nothing about the record.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const {find, one, rows, call, denied} = lib
const C = "mantle.party.ExternalAccessCapability"
const issuedInvoice = ["InvoiceFinalized", "InvoiceSent", "InvoiceAcked", "InvoicePmtRecvd"]
const closedOrder = ["OrderOpen", "OrderRequested", "OrderProposed", "OrderRejected", "OrderCancelled"]
const internal = partyId => !!partyId && !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
// Each record type: what it is for an outside party (organization, party, revision) when it may be reached at all, and
// the permission to issue or revoke its capabilities.
const records = {
    Invoice: {
        permission: "RECEIVABLE_EDIT",
        scopes: ["InvoicePay"],
        page: {app: "billing", path: "/InvoicePay?token="},
        resolve(recordId) {
            const invoice = one("mantle.account.invoice.Invoice", {invoiceId: recordId})
            if (!invoice || !issuedInvoice.includes(invoice.statusId) || !internal(invoice.fromPartyId)) return null
            if (internal(invoice.toPartyId)) return null
            return {organizationPartyId: invoice.fromPartyId, partyId: invoice.toPartyId, revision: String(lib.ms(invoice.lastUpdatedStamp))}
        }
    },
    Order: {
        permission: "PAYABLE_EDIT",
        scopes: ["BillUpload", "OrderAcknowledgement"],
        page: {app: "supplier", path: "/BillUpload?token="},
        resolve(recordId) {
            const order = one("mantle.order.OrderHeader", {orderId: recordId})
            if (!order || closedOrder.includes(order.statusId)) return null
            const part = rows("mantle.order.OrderPart", {orderId: recordId}).find(
                row => internal(row.customerPartyId) && row.vendorPartyId && !internal(row.vendorPartyId)
            )
            if (!part) return null
            return {
                organizationPartyId: part.customerPartyId,
                partyId: part.vendorPartyId,
                orderPartSeqId: part.orderPartSeqId,
                revision: String(lib.ms(order.lastUpdatedStamp))
            }
        }
    }
}
const unavailable = () => {
    const error = new Error("This link is not available")
    error.moquiErrorKind = "NotFound"
    throw error
}
function recordOf(recordType, recordId) {
    const kind = records[recordType]
    return kind && recordId ? kind.resolve(recordId) : null
}
// An internal user issuing or revoking: the record type's permission in the record's organization.
function requireIssuer(recordType, recordId) {
    const kind = records[recordType]
    if (!kind) denied("RECORD_TYPE_INVALID", "External access is not available for this record")
    const record = recordOf(recordType, recordId)
    if (!record) denied("RECORD_UNAVAILABLE", "This record cannot be shared outside the organization now")
    lib.organization(record.organizationPartyId, kind.permission)
    return record
}
function scopeList(scopes) {
    return (Array.isArray(scopes) ? scopes : String(scopes || "").split(","))
        .map(scope => String(scope).trim())
        .filter(Boolean)
}
// A new capability with its token, shown once; the caller has checked who may issue it.
function create(p) {
    const kind = records[p.recordType]
    const scopes = scopeList(p.scopes)
    if (!kind || !scopes.length || scopes.some(scope => !kind.scopes.includes(scope)))
        denied("SCOPE_INVALID", "Choose what the link allows")
    const record = recordOf(p.recordType, p.recordId)
    if (!record) denied("RECORD_UNAVAILABLE", "This record cannot be shared outside the organization now")
    const days = Math.min(Math.max(Number(p.validDays || 60), 1), 366)
    const thruDate = p.thruDate ? new Date(lib.ms(p.thruDate)) : new Date(Date.now() + days * 86400000)
    if (lib.ms(thruDate) <= Date.now()) denied("EXPIRY_INVALID", "Choose an expiry in the future")
    const token = ec.user.randomString(48)
    const out = call("create#" + C, {
        organizationPartyId: record.organizationPartyId,
        partyId: record.partyId,
        recordType: p.recordType,
        recordId: p.recordId,
        recordRevision: record.revision,
        scopes: scopes.join(","),
        tokenDigest: ec.user.singleUseCodeHash(token),
        fromDate: ec.user.nowTimestamp,
        thruDate,
        createdByUserId: ec.user.userId
    })
    // the link: the record's page of the organization's first published site with the app
    const apps = ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
    const siteId = apps.sitesFor(kind.page.app, record.organizationPartyId)[0]
    const url = siteId ? apps.pageUrl(siteId, kind.page.app, kind.page.path + encodeURIComponent(token)) : null
    return {capabilityId: out.capabilityId, token, url, thruDate, organizationPartyId: record.organizationPartyId}
}
// Where a failed token lookup comes from: a registered PASS deployment forwards its browser's address.
function requesterKey() {
    const request = ec.web?.request
    if (!request) return "service"
    const clientId = request.getHeader("x-pass-client") || "",
        forwarded = request.getHeader("x-pass-client-ip") || ""
    const account = ec.resource.script("component://framework/service/org/moqui/public/Account.js")
    if (forwarded && account.clientRegistered(clientId, request.getHeader("x-pass-client-secret") || "", null))
        return "client:" + clientId + ":" + forwarded.slice(0, 64)
    return request.remoteAddr || "service"
}
// The capability a token names while it is in effect, or null. Misses are limited per requester, as PASS limits sign-in.
function tokenCapability(token) {
    const text = String(token || "")
    const row = text.length >= 32 && text.length <= 128 ? one(C, {tokenDigest: ec.user.singleUseCodeHash(text)}) : null
    if (row && !row.revokedDate && lib.entityLib.active(row)) return row
    const allowed = ec.service
        .sync()
        .throwOnError(true)
        .name("org.moqui.public.AccountServices.record#Attempt")
        .parameters({input: {key: "access-token:" + requesterKey(), limit: 30, windowMillis: 600000}})
        .requireNewTransaction(true)
        .call().result.allowed
    if (!allowed) {
        const error = new Error("Wait before trying another link")
        error.moquiErrorKind = "Tarpit"
        throw error
    }
    return null
}
// A signed-in user's party is a contact of the outside party (PrtContact, in effect), as an invitation made it.
function contactOf(partyId) {
    const userPartyId = ec.user.userAccount?.partyId
    if (!userPartyId || !partyId) return false
    return rows("mantle.party.PartyRelationship", {
        fromPartyId: userPartyId,
        toPartyId: partyId,
        relationshipTypeEnumId: "PrtContact"
    }).some(row => lib.entityLib.active(row))
}
// What a page may reach: a token's record within its scope, or a record whose outside party the signed-in user is a
// contact of. organizationPartyId, when given, is the organization the page serves (its app mount's target).
function check(p) {
    const kind = records[p.recordType]
    if (!kind || !kind.scopes.includes(p.scope)) unavailable()
    if (p.token) {
        const row = tokenCapability(p.token)
        if (
            !row ||
            row.recordType !== p.recordType ||
            (p.recordId && row.recordId !== p.recordId) ||
            !scopeList(row.scopes).includes(p.scope) ||
            (p.organizationPartyId && row.organizationPartyId !== p.organizationPartyId)
        )
            unavailable()
        const record = recordOf(row.recordType, row.recordId)
        if (!record || record.organizationPartyId !== row.organizationPartyId || record.partyId !== row.partyId) unavailable()
        return {via: "token", capabilityId: row.capabilityId, recordId: row.recordId, ...record}
    }
    const record = recordOf(p.recordType, p.recordId)
    if (!record || (p.organizationPartyId && record.organizationPartyId !== p.organizationPartyId) || !contactOf(record.partyId))
        unavailable()
    return {via: "contact", capabilityId: null, recordId: p.recordId, ...record}
}
// The outside parties a signed-in user is a contact of.
function contactParties() {
    const userPartyId = ec.user.userAccount?.partyId
    if (!userPartyId) return []
    return rows("mantle.party.PartyRelationship", {fromPartyId: userPartyId, relationshipTypeEnumId: "PrtContact"})
        .filter(row => lib.entityLib.active(row))
        .map(row => row.toPartyId)
}
function revoke(p) {
    const row = find(C, {capabilityId: p.capabilityId}).forUpdate(true).one()
    if (!row) denied("CAPABILITY_UNAVAILABLE", "This link is not available")
    requireIssuer(row.recordType, row.recordId)
    if (!row.revokedDate)
        call("update#" + C, {capabilityId: row.capabilityId, revokedDate: ec.user.nowTimestamp, revokedByUserId: ec.user.userId})
    return {capabilityId: row.capabilityId, revoked: true}
}
// The links of a record, newest first, without their tokens.
function list(p) {
    requireIssuer(p.recordType, p.recordId)
    const now = Date.now()
    return Array.from(find(C, {recordType: p.recordType, recordId: p.recordId}).orderBy("-fromDate").limit(50).list()).map(
        row => ({
            capabilityId: row.capabilityId,
            scopes: row.scopes,
            fromDate: row.fromDate,
            thruDate: row.thruDate,
            revokedDate: row.revokedDate,
            active: !row.revokedDate && lib.ms(row.thruDate) > now
        })
    )
}
// An invitation to an app's pages bound to an outside party (a customer for Billing, a supplier for Supplier): an
// internal user with the record kind's permission in the organization the app serves. Redeeming it (redeem#Invitation)
// makes the account's party a contact of that party.
const appKinds = {billing: {permission: "RECEIVABLE_EDIT", role: "Customer"}, supplier: {permission: "PAYABLE_EDIT", role: "Supplier"}}
function invite(p) {
    const app = appKinds[p.app]
    if (!app) denied("APP_INVALID", "Choose the app to invite the contact to")
    lib.organization(p.organizationPartyId, app.permission)
    const party = one("mantle.party.Party", {partyId: p.partyId})
    if (!party || internal(p.partyId) || party.partyTypeEnumId !== "PtyOrganization")
        denied("PARTY_INVALID", "Choose an outside organization")
    const apps = ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
    const siteId = apps.sitesFor(p.app, p.organizationPartyId)[0]
    if (!siteId) denied("SITE_UNAVAILABLE", "The organization has no published site with this app")
    const email = String(p.emailAddress || "").trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) denied("EMAIL_INVALID", "Enter the contact's email address")
    const token = ec.user.randomString(32) + ec.user.randomString(32)
    const invitationId = ec.user.randomString(32)
    const expiresAt = new Date(Date.now() + 14 * 86400000)
    call("create#mantle.public.PublicSiteInvitation", {
        invitationId,
        siteId,
        tokenHash: ec.user.singleUseCodeHash(token),
        emailHash: ec.user.singleUseCodeHash(email),
        scopes: JSON.stringify([{app: p.app, partyId: p.partyId, organizationPartyId: p.organizationPartyId}]),
        inviterPartyId: ec.user.userAccount?.partyId,
        expiresAt
    })
    return {
        invitationId,
        siteId,
        token,
        expiresAt,
        invitationUrl: apps.pageUrl(siteId, "account", "/Invitation?token=" + encodeURIComponent(token))
    }
}
// On redeem: the account's party becomes a contact of each outside party the invitation names.
function bindContact(partyId, scopes) {
    for (const scope of Array.isArray(scopes) ? scopes : []) {
        if (!scope?.partyId || !appKinds[scope.app]) continue
        const existing = rows("mantle.party.PartyRelationship", {
            fromPartyId: partyId,
            toPartyId: scope.partyId,
            relationshipTypeEnumId: "PrtContact"
        }).some(row => lib.entityLib.active(row))
        if (!existing)
            call("create#mantle.party.PartyRelationship", {
                fromPartyId: partyId,
                toPartyId: scope.partyId,
                relationshipTypeEnumId: "PrtContact",
                toRoleTypeId: appKinds[scope.app].role,
                fromDate: ec.user.nowTimestamp
            })
    }
}
;({records, recordOf, requireIssuer, create, check, tokenCapability, contactOf, contactParties, revoke, list, invite, bindContact})
