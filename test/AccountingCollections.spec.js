// Collections (AC-10): a contact with its outcome and next action, a promise and its state, dunning levels, and a reminder
// run that leaves out a disputed invoice and, when one recipient fails, sends the rest and later only the one that failed.
// Standalone: spec-local organization, customers and users; mail through the capture.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingReceivablesFixtures.js")
const svc = (name, p) => helper().call(name, p)
const collections = (name, p) => helper().call("mantle.account.CollectionServices." + name, p)
const refused = (name, p) => helper().rejected(name, p)
const one = (entity, key) => helper().lib.one(entity, key)
const rows = (entity, key) => helper().lib.rows(entity, key)
const capture = ec.factory.getTool("MailCapture")
const prefix = "NATIVE_COLL"
const day = offset => ec.l10n.format(new Date(Number(ec.user.nowTimestamp) + offset * 86400000), "yyyy-MM-dd")
let f, second, overdueId, disputedId, secondId, runId

// An issued invoice of the organization to a customer, due a number of days ago.
function overdue(customerPartyId, amount, daysAgo) {
    login(f.users.ar)
    const made = svc("mantle.account.InvoiceServices.create#Receivable", {organizationPartyId: f.org, customerPartyId})
    svc("mantle.account.InvoiceServices.store#InvoiceDraftItem", {
        invoiceId: made.invoiceId,
        itemTypeEnumId: "ItemTimeEntry",
        quantity: "1",
        amount,
        description: "Consulting"
    })
    const invoice = one("mantle.account.invoice.Invoice", {invoiceId: made.invoiceId})
    svc("mantle.account.InvoiceServices.change#InvoiceState", {
        invoiceId: made.invoiceId,
        action: "finalize",
        lastUpdatedStamp: invoice.lastUpdatedStamp
    })
    login("john.doe")
    svc("update#mantle.account.invoice.Invoice", {
        invoiceId: made.invoiceId,
        dueDate: new Date(Number(ec.user.nowTimestamp) - daysAgo * 86400000)
    })
    return made.invoiceId
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures(prefix)
        svc("mantle.party.ContactServices.create#EmailAddress", {
            partyId: f.customer,
            emailAddress: "payables@customer.example",
            contactMechPurposeId: "EmailBilling"
        })
        second = prefix + "_SECOND"
        svc("create#mantle.party.Party", {partyId: second, partyTypeEnumId: "PtyOrganization"})
        svc("create#mantle.party.Organization", {partyId: second, organizationName: prefix + " second customer"})
        svc("create#mantle.party.PartyRole", {partyId: second, roleTypeId: "Customer"})
        capture.enable()
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    },
    cleanupSpec() {
        capture.reset()
    }
})

feature("AR records a call with its outcome and a next action on the customer; a reader cannot", {
    when() {
        overdueId = overdue(f.customer, "120", 12)
        login(f.users.ar)
        const recorded = collections("record#Activity", {
            organizationPartyId: f.org,
            customerPartyId: f.customer,
            activityType: "call",
            outcomeEnumId: "CaoReached",
            note: "Will pay next week",
            nextActionDate: new Date(Number(ec.user.nowTimestamp) + 2 * 86400000),
            nextActionName: "Call again"
        })
        const history = collections("get#CustomerCollections", {organizationPartyId: f.org, customerPartyId: f.customer})
        login(f.users.read)
        const denied = refused("mantle.account.CollectionServices.record#Activity", {
            organizationPartyId: f.org,
            customerPartyId: f.customer,
            outcomeEnumId: "CaoReached"
        })
        return {
            recorded,
            done: one("mantle.work.effort.WorkEffort", {workEffortId: recorded.workEffortId}),
            next: one("mantle.work.effort.WorkEffort", {workEffortId: recorded.nextWorkEffortId}),
            link: one("mantle.work.effort.WorkEffortRecord", {
                workEffortId: recorded.workEffortId,
                recordEntityName: "mantle.party.Party",
                recordId: f.customer
            }),
            assigned: rows("mantle.work.effort.WorkEffortParty", {
                workEffortId: recorded.nextWorkEffortId,
                roleTypeId: "Assignee"
            }),
            history,
            denied
        }
    },
    then({done, next, link, assigned, history, denied}) {
        done.statusId == "WeComplete"
        done.purposeEnumId == "WepPhoneCall"
        next.statusId != "WeComplete"
        next.workEffortName == "Call again"
        link != null
        assigned.some(row => row.partyId == f.users.ar)
        history.activities.length == 2
        history.nextActions.length == 1
        history.activities.some(row => row.outcomeText == "Reached the customer" && row.description == "Will pay next week")
        denied.includes("PERMISSION_DENIED")
    }
})

feature("a promise to pay is open until its day and cannot be dated in the past; a dispute marks its invoice", {
    when() {
        disputedId = overdue(f.customer, "40", 5)
        login(f.users.ar)
        const past = refused("mantle.account.CollectionServices.store#Promise", {
            organizationPartyId: f.org,
            customerPartyId: f.customer,
            amount: "50",
            promisedDate: day(-1)
        })
        const promise = collections("store#Promise", {
            organizationPartyId: f.org,
            customerPartyId: f.customer,
            amount: "50",
            promisedDate: day(3),
            invoiceIdList: [overdueId]
        })
        const open = collections("get#CustomerCollections", {organizationPartyId: f.org, customerPartyId: f.customer}).promises
        collections("store#Promise", {
            organizationPartyId: f.org,
            customerPartyId: f.customer,
            collectionPromiseId: promise.collectionPromiseId,
            cancel: "Y"
        })
        collections("record#Activity", {
            organizationPartyId: f.org,
            customerPartyId: f.customer,
            outcomeEnumId: "CaoDisputed",
            note: "Hours not agreed",
            invoiceIdList: [disputedId]
        })
        const after = collections("get#CustomerCollections", {organizationPartyId: f.org, customerPartyId: f.customer})
        return {past, open, after, disputed: one("mantle.account.invoice.Invoice", {invoiceId: disputedId})}
    },
    then({past, open, after, disputed}) {
        past.includes("PROMISED_DATE_PAST")
        open.length == 1
        open[0].state == "open"
        after.promises[0].state == "cancelled"
        disputed.disputedDate != null
        disputed.disputeNote == "Hours not agreed"
        after.disputedInvoices.some(row => row.invoiceId == disputedId)
    }
})

feature("the finance admin sets the dunning levels; AR cannot, and two levels cannot start on the same day", {
    when() {
        const level = {organizationPartyId: f.org, emailTemplateId: f.emailTemplateId, changeReason: "Setup"}
        login(f.users.ar)
        const denied = refused(
            "mantle.account.CollectionServices.store#Level",
            Object.assign({description: "Friendly reminder", daysOverdueFrom: 1}, level)
        )
        login(f.users.financeadmin)
        const first = collections("store#Level", Object.assign({description: "Friendly reminder", daysOverdueFrom: 1}, level))
        const secondLevel = collections(
            "store#Level",
            Object.assign({description: "Second reminder", daysOverdueFrom: 30, cadenceDays: 14}, level)
        )
        const duplicate = refused(
            "mantle.account.CollectionServices.store#Level",
            Object.assign({description: "Again", daysOverdueFrom: 30}, level)
        )
        return {denied, first, secondLevel, duplicate}
    },
    then({denied, first, secondLevel, duplicate}) {
        denied.includes("PERMISSION_DENIED")
        !!first.dunningLevelId
        one("mantle.account.invoice.DunningLevel", {dunningLevelId: secondLevel.dunningLevelId}).sequenceNum == 2
        duplicate.includes("LEVEL_DUPLICATE")
    }
})

feature("a reminder run leaves out the disputed invoice and names why", {
    when() {
        secondId = overdue(second, "75", 8)
        login(f.users.ar)
        const preview = collections("preview#Dunning", {organizationPartyId: f.org})
        runId = preview.dunningRunId
        const run = collections("get#DunningRun", {dunningRunId: runId})
        return {preview, notices: run.notices}
    },
    then({preview, notices}) {
        preview.noticeCount == 2
        preview.incomplete == false
        notices.some(row => row.customerPartyId == f.customer && row.statusId == "DntPending" && row.invoiceIds == overdueId)
        notices.some(row => row.statusId == "DntExcluded" && row.excludedReason == "DISPUTED" && row.invoiceIds == disputedId)
        notices.some(row => row.customerPartyId == second && row.statusId == "DntPending" && row.invoiceIds == secondId)
    }
})

feature("a failed recipient does not stop the others, and sending again sends only the one that failed", {
    when() {
        capture.clear()
        login(f.users.ar)
        const sent = collections("send#Dunning", {dunningRunId: runId, operationKey: "dunning-first"})
        const repeated = collections("send#Dunning", {dunningRunId: runId, operationKey: "dunning-first"})
        const firstCount = capture.count()
        login("john.doe")
        // the second customer's notice failed for want of an address: it is given one, and the run sent again
        svc("mantle.party.ContactServices.create#EmailAddress", {
            partyId: second,
            emailAddress: "billing@second.example",
            contactMechPurposeId: "EmailBilling"
        })
        const failed = rows("mantle.account.invoice.DunningNotice", {dunningRunId: runId, customerPartyId: second})[0]
        svc("update#mantle.account.invoice.DunningNotice", {
            dunningRunId: runId,
            noticeSeqId: failed.noticeSeqId,
            toAddresses: "billing@second.example"
        })
        login(f.users.ar)
        const again = collections("send#Dunning", {dunningRunId: runId, operationKey: "dunning-second"})
        return {
            sent,
            repeated,
            firstCount,
            totalCount: capture.count(),
            last: capture.last(),
            run: one("mantle.account.invoice.DunningRun", {dunningRunId: runId}),
            notices: rows("mantle.account.invoice.DunningNotice", {dunningRunId: runId})
        }
    },
    then({sent, repeated, firstCount, totalCount, last, run, notices}) {
        sent.sentCount == 1
        sent.failedCount == 1
        sent.results.some(row => row.customerPartyId == second && row.reasonCode == "RECIPIENT_REQUIRED")
        repeated.alreadyApplied == true
        firstCount == 1
        totalCount == 2
        last.toList.join() == "billing@second.example"
        last.body.includes(secondId)
        run.statusId == "DrnSent"
        notices.filter(row => row.statusId == "DntSent").length == 2
    }
})
