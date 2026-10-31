// Accounting's customer and supplier pages on CX-PORTALS: ExternalAccessServices' capabilities, tokens and contact
// invitations, and PortalServices' invoice reads and payment through a hosted gateway, as the PASS Billing app calls
// them. The organizations, users, site and test gateways are spec-local. PASS's Portals spec covers the pages and the
// supplier's scanned upload.
const settlement = () => ec.resource.script("component://mr-mantle/test/AccountingSettlementFixtures.js")
const tests = "mantle.account.PaymentTestServices."
const capture = ec.factory.getTool("MailCapture")
let f, other, site, otherSite
// A portal operation as PASS calls it: its result, or the error kind a page shows.
function portal(name, input) {
    try {
        return ec.service
            .sync()
            .throwOnError(true)
            .name("mantle.account.PortalServices." + name)
            .parameters({input})
            .call().result
    } catch (error) {
        ec.message.clearErrors()
        return {errorKind: error.moquiErrorKind || "Error", errorMessage: String(error.message)}
    }
}
const access = (name, p) => settlement().call("mantle.party.ExternalAccessServices." + name, p)
const rejected = (name, p) => settlement().rejected("mantle.party.ExternalAccessServices." + name, p)
const invoice = (amount = "100") => settlement().invoice(f, amount)
const one = (entity, fields) => settlement().lib.one(entity, fields)
function gateway(id, authorize, details) {
    settlement().call("create#mantle.account.method.PaymentGatewayConfig", {
        paymentGatewayConfigId: id,
        paymentGatewayTypeEnumId: "PgtTest",
        description: "Portal gateway " + id,
        authorizeServiceName: tests + authorize + "#PaymentAuthorization",
        captureServiceName: tests + "alwaysApprove#PaymentCapture",
        detailsServiceName: tests + details + "#PaymentDetails"
    })
    settlement().call("create#mantle.account.method.PaymentGatewayOrganization", {
        organizationPartyId: f.org,
        paymentGatewayConfigId: id,
        fromDate: 0,
        isEnabled: "Y"
    })
}
const payThrough = paymentGatewayConfigId =>
    settlement().call("update#mantle.ledger.config.PartyAcctgPreference", {
        organizationPartyId: f.org,
        invoicePayGatewayConfigId: paymentGatewayConfigId
    })
function publicSite(siteId, org, hostname) {
    const c = settlement().call
    c("create#mantle.public.PublicSite", {
        siteId,
        name: siteId,
        state: "published",
        registrationMode: "invitation",
        locale: "en",
        timeZone: "UTC",
        policyRevision: 1,
        generation: 1
    })
    c("create#mantle.public.PublicSiteParty", {siteId, partyId: ec.user.userAccount.partyId, state: "active", role: "owner", revision: 1})
    c("mantle.public.SiteServices.store#Mounts", {
        input: {
            siteId,
            expectedRevision: 1,
            mounts: [
                {app: "forum", pathPrefix: "/forum"},
                {app: "account", pathPrefix: "/account"},
                {app: "billing", pathPrefix: "/billing", targetId: org},
                {app: "supplier", pathPrefix: "/supplier", targetId: org}
            ],
            hosts: [{hostname, canonical: true}]
        }
    })
    return siteId
}
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = settlement().fixtures("ACCT_PORTAL")
        other = settlement().fixtures("ACCT_PORTAL_OTHER")
        site = publicSite("ACCT_PORTAL_SITE", f.org, "billing.portal.example.test")
        otherSite = publicSite("ACCT_PORTAL_OTHER_SITE", other.org, "billing.other.example.test")
        gateway("ACCT_PORTAL_HOSTED", "hostedPending", "alwaysApprove")
        gateway("ACCT_PORTAL_WAIT", "hostedPending", "alwaysPending")
        gateway("ACCT_PORTAL_DECLINE", "alwaysDecline", "alwaysApprove")
        capture.enable()
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    },
    cleanupSpec() {
        capture.reset()
    }
})

feature("AR issues an invoice's capability in its organization; AP, another organization's user and a draft cannot", {
    when() {
        const invoiceId = invoice()
        const draft = settlement().base.draft(f).invoiceId
        login(f.users.ar)
        const issued = access("create#AccessCapability", {recordType: "Invoice", recordId: invoiceId, scopes: "InvoicePay"})
        const draftRefused = rejected("create#AccessCapability", {recordType: "Invoice", recordId: draft, scopes: "InvoicePay"})
        const scopeRefused = rejected("create#AccessCapability", {recordType: "Invoice", recordId: invoiceId, scopes: "BillUpload"})
        login(f.users.ap)
        const apRefused = rejected("create#AccessCapability", {recordType: "Invoice", recordId: invoiceId, scopes: "InvoicePay"})
        login(other.users.ar)
        const otherRefused = rejected("create#AccessCapability", {recordType: "Invoice", recordId: invoiceId, scopes: "InvoicePay"})
        login("john.doe")
        const row = one("mantle.party.ExternalAccessCapability", {capabilityId: issued.capabilityId})
        return {issued, row, draftRefused, scopeRefused, apRefused, otherRefused, check: access("check#AccessToken", {token: issued.token})}
    },
    then({issued, row, draftRefused, scopeRefused, apRefused, otherRefused, check}) {
        issued.token.length == 48
        row.tokenDigest != issued.token
        row.organizationPartyId == f.org
        row.partyId == f.customer
        row.createdByUserId == f.users.ar
        draftRefused.includes("RECORD_UNAVAILABLE")
        scopeRefused.includes("SCOPE_INVALID")
        apRefused.includes("PERMISSION_DENIED")
        otherRefused.includes("ORGANIZATION_DENIED")
        check.valid == true
        check.recordType == "Invoice"
    }
})

feature("a pay link shows only its invoice's public fields; another invoice, another organization's site, a revoked or an expired token say unavailable", {
    when() {
        const invoiceId = invoice("80"),
            otherInvoiceId = invoice("25")
        login(f.users.ar)
        const issued = access("create#AccessCapability", {recordType: "Invoice", recordId: invoiceId, scopes: "InvoicePay"})
        const expiring = access("create#AccessCapability", {recordType: "Invoice", recordId: invoiceId, scopes: "InvoicePay"})
        logout()
        const shown = portal("get#Invoice", {siteId: site, token: issued.token})
        const wrongInvoice = portal("get#Invoice", {siteId: site, token: issued.token, invoiceId: otherInvoiceId})
        const wrongSite = portal("get#Invoice", {siteId: otherSite, token: issued.token})
        const noToken = portal("get#Invoice", {siteId: site, invoiceId})
        const forged = portal("get#Invoice", {siteId: site, token: "x".repeat(48)})
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        settlement().call("update#mantle.party.ExternalAccessCapability", {capabilityId: expiring.capabilityId, thruDate: new Date(Date.now() - 1000)})
        login(f.users.ar)
        access("revoke#AccessCapability", {capabilityId: issued.capabilityId})
        logout()
        const revoked = portal("get#Invoice", {siteId: site, token: issued.token})
        const expired = portal("get#Invoice", {siteId: site, token: expiring.token})
        return {invoiceId, shown, wrongInvoice, wrongSite, noToken, forged, revoked, expired}
    },
    then({invoiceId, shown, wrongInvoice, wrongSite, noToken, forged, revoked, expired}) {
        shown.invoice.invoiceId == invoiceId
        shown.invoice.dueText.includes("80.00")
        shown.invoice.lines.length == 1
        Object.keys(shown.invoice).sort().join() ==
            "currencyUomId,due,dueDateText,dueText,fromName,invoiceDateText,invoiceId,lines,paidText,statusText,toName,totalText"
        Object.keys(shown.invoice.lines[0]).sort().join() == "amountText,description,quantity,totalText"
        shown.capabilities.canShare == false
        ;[wrongInvoice, wrongSite, noToken, forged, revoked, expired].every(out => out.errorKind == "NotFound")
        !JSON.stringify([wrongInvoice, wrongSite, revoked]).includes(invoiceId)
    }
})

feature("a hosted payment stays pending until the gateway answers: the return's claim never pays it, and a retry resumes it", {
    when() {
        const invoiceId = invoice("60")
        payThrough("ACCT_PORTAL_WAIT")
        login(f.users.ar)
        const token = access("create#AccessCapability", {recordType: "Invoice", recordId: invoiceId, scopes: "InvoicePay"}).token
        logout()
        const unconfirmed = portal("start#InvoicePayment", {siteId: site, token, operationId: "portal-pay-0001"})
        const started = portal("start#InvoicePayment", {siteId: site, token, operationId: "portal-pay-0002", confirm: true})
        const replay = portal("start#InvoicePayment", {siteId: site, token, operationId: "portal-pay-0002", confirm: true})
        const result = portal("get#PaymentResult", {siteId: site, token, attemptId: started.attempt.attemptId})
        const resumed = portal("start#InvoicePayment", {siteId: site, token, operationId: "portal-pay-0003", confirm: true})
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const payments = settlement().lib.rows("mantle.account.payment.Payment", {forInvoiceId: invoiceId})
        return {unconfirmed, started, replay, result, resumed, payments, after: one("mantle.account.invoice.Invoice", {invoiceId})}
    },
    then({unconfirmed, started, replay, result, resumed, payments, after}) {
        unconfirmed.errorKind == "Unprocessable"
        started.attempt.state == "pending"
        started.attempt.nextAction == "continue"
        started.attempt.redirectUrl.startsWith(
            "https://billing.portal.example.test/billing/InvoicePay/return?attemptId=" + started.attempt.attemptId
        )
        started.attempt.redirectUrl.includes("result=paid")
        replay.alreadyApplied == true
        replay.attempt.attemptId == started.attempt.attemptId
        result.attempt.state == "pending"
        result.invoice.dueText.includes("60.00")
        resumed.resumed == true
        resumed.attempt.attemptId == started.attempt.attemptId
        payments.length == 1
        payments[0].statusId == "PmntPromised"
        payments[0].paymentRefNum == "TEST-HOSTED-" + started.attempt.attemptId
        after.statusId == "InvoiceFinalized"
    }
})

feature("when the gateway approves, the result is paid and the payment is applied; a declined one can be tried again", {
    when() {
        const paidId = invoice("45"),
            declinedId = invoice("30")
        login(f.users.ar)
        const paidToken = access("create#AccessCapability", {recordType: "Invoice", recordId: paidId, scopes: "InvoicePay"}).token
        const declinedToken = access("create#AccessCapability", {recordType: "Invoice", recordId: declinedId, scopes: "InvoicePay"}).token
        login("john.doe")
        payThrough("ACCT_PORTAL_HOSTED")
        logout()
        const started = portal("start#InvoicePayment", {siteId: site, token: paidToken, operationId: "portal-pay-0101", confirm: true})
        const result = portal("get#PaymentResult", {siteId: site, token: paidToken, attemptId: started.attempt.attemptId})
        const afterPaid = portal("get#Invoice", {siteId: site, token: paidToken})
        const again = portal("start#InvoicePayment", {siteId: site, token: paidToken, operationId: "portal-pay-0102", confirm: true})
        login("john.doe")
        payThrough("ACCT_PORTAL_DECLINE")
        logout()
        const declined = portal("start#InvoicePayment", {siteId: site, token: declinedToken, operationId: "portal-pay-0103", confirm: true})
        const retry = portal("get#Invoice", {siteId: site, token: declinedToken})
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        return {started, result, afterPaid, again, declined, retry, paid: one("mantle.account.invoice.Invoice", {invoiceId: paidId})}
    },
    then({started, result, afterPaid, again, declined, retry, paid}) {
        started.attempt.state == "pending"
        result.attempt.state == "paid"
        result.attempt.reference == "TEST-HOSTED-" + started.attempt.attemptId
        paid.statusId == "InvoicePmtRecvd"
        toDecimal(paid.unpaidTotal).eq(0)
        afterPaid.invoice.statusText == "Paid"
        afterPaid.capabilities.canPay == false
        again.errorKind == "Conflict"
        declined.attempt.state == "declined"
        declined.attempt.nextAction == "retry"
        retry.capabilities.canPay == true
        retry.attempt == null
    }
})

feature("an invited contact redeems into a contact of the customer, with no user group, and sees and shares only its invoices", {
    when() {
        const invoiceId = invoice("70"),
            otherCustomerInvoice = settlement().invoice(other, "20")
        login(f.users.ap)
        const apRefused = rejected("invite#Contact", {
            organizationPartyId: f.org,
            app: "billing",
            partyId: f.customer,
            emailAddress: "payer@customer.example"
        })
        login(f.users.ar)
        const invited = access("invite#Contact", {
            organizationPartyId: f.org,
            app: "billing",
            partyId: f.customer,
            emailAddress: "Payer@Customer.example"
        })
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const c = settlement().call
        c("create#mantle.party.Party", {partyId: "ACCT_PORTAL_PAYER", partyTypeEnumId: "PtyPerson"})
        c("create#mantle.party.Person", {partyId: "ACCT_PORTAL_PAYER", firstName: "Portal", lastName: "Payer"})
        c("create#moqui.security.UserAccount", {
            userId: "ACCT_PORTAL_PAYER",
            username: "acct.portal.payer",
            partyId: "ACCT_PORTAL_PAYER",
            emailAddress: "payer@customer.example",
            currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
            passwordHashType: "SHA"
        })
        c("create#moqui.security.public.VerifiedAddress", {
            userId: "ACCT_PORTAL_PAYER",
            emailAddress: "payer@customer.example",
            verifiedAt: ec.user.nowTimestamp
        })
        login("acct.portal.payer")
        const before = portal("find#Invoices", {siteId: site})
        c("mantle.public.SiteServices.redeem#Invitation", {input: {siteId: site, token: invited.token}})
        const list = portal("find#Invoices", {siteId: site})
        const shown = portal("get#Invoice", {siteId: site, invoiceId})
        const foreign = portal("get#Invoice", {siteId: otherSite, invoiceId: otherCustomerInvoice})
        const shared = portal("issue#InvoiceAccess", {siteId: site, invoiceId})
        logout()
        const anonymousList = portal("find#Invoices", {siteId: site})
        const viaShared = portal("get#Invoice", {siteId: site, token: shared.token})
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const groups = settlement().lib.rows("moqui.security.UserGroupMember", {userId: "ACCT_PORTAL_PAYER"})
        return {apRefused, invited, before, list, shown, foreign, shared, anonymousList, viaShared, groups, invoiceId}
    },
    then({apRefused, invited, before, list, shown, foreign, shared, anonymousList, viaShared, groups, invoiceId}) {
        apRefused.includes("PERMISSION_DENIED")
        invited.invitationUrl.startsWith("https://billing.portal.example.test/account/Invitation?token=")
        before.invoiceList.length == 0
        list.invoiceList.some(row => row.invoiceId == invoiceId)
        list.invoiceList.every(row => row.toName.includes("ACCT_PORTAL customer"))
        shown.invoice.invoiceId == invoiceId
        shown.capabilities.canShare == true
        foreign.errorKind == "NotFound"
        shared.url.startsWith("https://billing.portal.example.test/billing/InvoicePay?token=")
        anonymousList.errorKind == "AuthenticationRequired"
        viaShared.invoice.invoiceId == invoiceId
        viaShared.capabilities.canShare == false
        groups.length == 0
    }
})

feature("send#Invoice carries the pay link of the organization's Billing site", {
    when() {
        login(f.users.ar)
        const draft = settlement().base.draft(f, "55")
        capture.clear()
        const sent = settlement().call("mantle.account.InvoiceServices.send#Invoice", {
            invoiceId: draft.invoiceId,
            organizationPartyId: f.org,
            operationKey: "portal-send-0001",
            emailTemplateId: f.emailTemplateId,
            toAddresses: "payer@customer.example",
            lastUpdatedStamp: draft.lastUpdatedStamp
        })
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const links = settlement().lib.rows("mantle.party.ExternalAccessCapability", {recordId: draft.invoiceId})
        return {sent, message: capture.last(), links}
    },
    then({sent, message, links}) {
        sent.successCount == 1
        message.body.includes("https://billing.portal.example.test/billing/InvoicePay?token=")
        message.body.includes("View and pay this invoice online")
        links.length == 1
        links[0].scopes == "InvoicePay"
    }
})

feature("Billing and Supplier mounts take an internal organization from an operator, survive a core save and add readiness", {
    when() {
        const c = settlement().call
        const mounts = input => settlement().rejected("mantle.public.SiteServices.store#Mounts", {input})
        const revision = () => one("mantle.public.PublicSite", {siteId: site}).policyRevision
        const notInternal = mounts({
            siteId: site,
            expectedRevision: revision(),
            mounts: [{app: "billing", pathPrefix: "/billing", targetId: f.customer}]
        })
        const forumTarget = mounts({
            siteId: site,
            expectedRevision: revision(),
            mounts: [{app: "forum", pathPrefix: "/forum", targetId: f.org}]
        })
        c("mantle.public.SiteServices.store#Mounts", {
            input: {siteId: site, expectedRevision: revision(), mounts: [{app: "forum", pathPrefix: "/forum"}, {app: "account", pathPrefix: "/account"}]}
        })
        const kept = settlement().lib.rows("mantle.public.PublicSiteApp", {siteId: site}).map(row => row.app + ":" + (row.targetId || ""))
        payThrough("ACCT_PORTAL_HOSTED")
        const ready = c("mantle.public.SiteServices.check#Readiness", {input: {siteId: site}}).result.checks
        payThrough(null)
        const unready = c("mantle.public.SiteServices.check#Readiness", {input: {siteId: site}}).result.checks
        return {notInternal, forumTarget, kept, ready, unready}
    },
    then({notInternal, forumTarget, kept, ready, unready}) {
        notInternal.includes("Choose the organization")
        forumTarget.includes("takes no target")
        kept.sort().join() == ["account:", "billing:" + f.org, "forum:", "supplier:" + f.org].join()
        ready.find(c => c.name == "billing payment gateway").ready == true
        ready.find(c => c.name == "billing organization").ready == true
        unready.find(c => c.name == "billing payment gateway").ready == false
    }
})
