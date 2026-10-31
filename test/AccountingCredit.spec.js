// Customer credit and order holds (AC-11, CX-ORDER-HOLD): the policy as dated rows, an order over its customer's limit
// held on a manual approval and on Mantle's automatic one alike with its reservations kept, released by a credit manager
// with a reason, a warn policy, a customer without a policy, and a second hold reason that keeps the order held.
// Standalone: spec-local organization, customers and users.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingReceivablesFixtures.js")
const svc = (name, p) => helper().call(name, p)
const refused = (name, p) => helper().rejected(name, p)
const one = (entity, key) => helper().lib.one(entity, key)
const rows = (entity, key) => helper().lib.rows(entity, key)
const prefix = "NATIVE_CREDIT"
let f, credit, approver, heldOrderId, warnedCustomer
const facility = prefix + "_WH"

function user(kind, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    svc("create#moqui.security.UserGroup", {userGroupId: id, description: "Credit " + kind})
    for (const permission of permissions)
        svc("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: 0})
    svc("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    svc("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: ec.user.userAccount?.timeZone || "America/Chicago"
    })
    svc("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: 0})
    svc("create#mantle.party.PartyRelationship", {
        partyRelationshipId: id,
        fromPartyId: id,
        toPartyId: f.org,
        relationshipTypeEnumId: "PrtAgent",
        fromDate: 0
    })
    return id
}
// A placed sales order of the organization to the customer: five of DEMO_1_2 at 10, with an authorized payment for its
// total when paid.
function order(customerPartyId, paid = false) {
    login("john.doe")
    const made = svc("mantle.order.OrderServices.create#Order", {
        vendorPartyId: f.org,
        customerPartyId,
        currencyUomId: "USD",
        facilityId: facility
    })
    svc("mantle.order.OrderServices.add#OrderProductQuantity", {
        orderId: made.orderId,
        orderPartSeqId: made.orderPartSeqId,
        productId: "DEMO_1_2",
        quantity: 5,
        unitAmount: 10,
        itemTypeEnumId: "ItemProduct"
    })
    if (paid)
        svc("create#mantle.account.payment.Payment", {
            paymentId: made.orderId + "_PAY",
            orderId: made.orderId,
            orderPartSeqId: made.orderPartSeqId,
            fromPartyId: customerPartyId,
            toPartyId: f.org,
            amount: 50,
            amountUomId: "USD",
            paymentInstrumentEnumId: "PiCreditCard",
            statusId: "PmntAuthorized"
        })
    svc("mantle.order.OrderServices.place#Order", {orderId: made.orderId, requireInventory: false})
    return made.orderId
}
const status = orderId => one("mantle.order.OrderHeader", {orderId}).statusId
const openReasons = orderId => rows("mantle.order.OrderHoldReason", {orderId}).filter(row => !row.releasedDate)
function policy(customerPartyId, values) {
    login(credit)
    return svc(
        "mantle.account.CreditServices.store#Policy",
        Object.assign({organizationPartyId: f.org, customerPartyId, changeReason: "Credit review"}, values)
    )
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures(prefix)
        svc("create#mantle.facility.Facility", {facilityId: facility, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: f.org})
        credit = user("manager", ["CREDIT_HOLD_RELEASE", "CUSTOMER_CREDIT_VIEW", "RECEIVABLE_VIEW"])
        approver = user("approver", ["ORDER_APPROVE"])
        warnedCustomer = prefix + "_WARNED"
        svc("create#mantle.party.Party", {partyId: warnedCustomer, partyTypeEnumId: "PtyOrganization"})
        svc("create#mantle.party.Organization", {partyId: warnedCustomer, organizationName: prefix + " warned customer"})
        svc("create#mantle.party.PartyRole", {partyId: warnedCustomer, roleTypeId: "Customer"})
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    }
})

feature("a credit manager sets a customer's limit as dated rows; AR and the default need more authority", {
    when() {
        const first = policy(f.customer, {creditLimit: 20, actionEnumId: "CpaHold"})
        const same = policy(f.customer, {creditLimit: 20, actionEnumId: "CpaHold"})
        login(f.users.ar)
        const denied = refused("mantle.account.CreditServices.store#Policy", {
            organizationPartyId: f.org,
            customerPartyId: f.customer,
            creditLimit: 30,
            changeReason: "Raise"
        })
        login(credit)
        const noDefault = refused("mantle.account.CreditServices.store#Defaults", {
            organizationPartyId: f.org,
            creditLimit: 1000,
            changeReason: "Default"
        })
        const empty = refused("mantle.account.CreditServices.store#Policy", {
            organizationPartyId: f.org,
            customerPartyId: f.customer,
            changeReason: "Nothing"
        })
        login(f.users.financeadmin)
        const defaults = svc("mantle.account.CreditServices.store#Defaults", {
            organizationPartyId: f.org,
            creditLimit: 1000,
            actionEnumId: "CpaWarn",
            changeReason: "Default"
        })
        const ended = svc("mantle.account.CreditServices.store#Defaults", {
            organizationPartyId: f.org,
            changeReason: "No default",
            ended: "Y"
        })
        return {first, same, denied, noDefault, empty, defaults, ended}
    },
    then({first, same, denied, noDefault, empty, defaults, ended}) {
        first.changed == true
        same.changed == false
        same.customerCreditPolicyId == first.customerCreditPolicyId
        denied.includes("PERMISSION_DENIED")
        noDefault.includes("PERMISSION_DENIED")
        empty.includes("POLICY_EMPTY")
        defaults.changed == true
        ended.changed == true
    }
})

feature("an order over the limit is held on a manual approval, keeps its reservations and is not approved again", {
    when() {
        heldOrderId = order(f.customer)
        const reservationsBefore = rows("mantle.product.issuance.AssetReservation", {orderId: heldOrderId}).length
        login(approver)
        const approved = svc("mantle.order.OrderServices.approve#Order", {orderId: heldOrderId})
        const again = refused("mantle.order.OrderServices.approve#Order", {orderId: heldOrderId})
        login(credit)
        const creditStatus = svc("mantle.account.CreditServices.get#CustomerCreditStatus", {
            organizationPartyId: f.org,
            customerPartyId: f.customer
        })
        login(f.users.ap)
        const noView = refused("mantle.account.CreditServices.get#CustomerCreditStatus", {
            organizationPartyId: f.org,
            customerPartyId: f.customer
        })
        const notices = rows("moqui.security.user.NotificationMessage", {topic: "CreditHoldRelease", recordId: heldOrderId})
        const recipients = notices.length
            ? rows("moqui.security.user.NotificationMessageUser", {notificationMessageId: notices[0].notificationMessageId})
            : []
        return {
            approved,
            again,
            status: status(heldOrderId),
            reasons: openReasons(heldOrderId),
            reservationsBefore,
            reservationsAfter: rows("mantle.product.issuance.AssetReservation", {orderId: heldOrderId}).length,
            creditStatus,
            noView,
            recipients
        }
    },
    then({approved, again, status, reasons, reservationsBefore, reservationsAfter, creditStatus, noView, recipients}) {
        approved.creditHeld == true
        status == "OrderHold"
        reasons.length == 1
        reasons[0].holdTypeEnumId == "OhtCredit"
        reasons[0].holdComment.includes("over the limit")
        reservationsBefore > 0
        reservationsAfter == reservationsBefore
        again.includes("ORDER_HOLD_OPEN")
        creditStatus.policy.source == "customer"
        creditStatus.exposure.exposure.eq(50)
        creditStatus.available.eq(-30)
        creditStatus.holds.some(row => row.orderId == heldOrderId)
        noView.includes("PERMISSION_DENIED")
        recipients.some(row => row.userId == credit)
    }
})

feature("a credit manager releases the hold with a reason; the order is approved and the decision recorded", {
    when() {
        login(f.users.ar)
        const denied = refused("mantle.account.CreditServices.release#CreditHold", {orderId: heldOrderId, reason: "Paid soon"})
        login(credit)
        const noReason = refused("mantle.account.CreditServices.release#CreditHold", {orderId: heldOrderId, reason: " "})
        const released = svc("mantle.account.CreditServices.release#CreditHold", {
            orderId: heldOrderId,
            reason: "Known customer, paying this week"
        })
        const decision = one("mantle.account.billing.CreditHoldDecision", {creditHoldDecisionId: released.creditHoldDecisionId})
        const unread = rows("moqui.security.user.NotificationMessage", {topic: "CreditHoldRelease", recordId: heldOrderId})
            .flatMap(row =>
                rows("moqui.security.user.NotificationMessageUser", {notificationMessageId: row.notificationMessageId})
            )
            .filter(row => !row.viewedDate)
        return {denied, noReason, released, decision, status: status(heldOrderId), unread}
    },
    then({denied, noReason, released, decision, status, unread}) {
        denied.includes("PERMISSION_DENIED")
        noReason.includes("REASON_REQUIRED")
        released.statusId == "OrderApproved"
        status == "OrderApproved"
        decision.decisionEnumId == "CrdRelease"
        decision.decidedByUserId == credit
        decision.exposureAmount.eq(50)
        decision.creditLimit.eq(20)
        unread.length == 0
    }
})

feature("Mantle's automatic approval holds a paid order of a customer already over its limit", {
    when() {
        // the approved order of 50 is still not invoiced, so the customer is over its limit of 20 before this order
        const orderId = order(f.customer, true)
        return {status: status(orderId), reasons: openReasons(orderId)}
    },
    then({status, reasons}) {
        status == "OrderHold"
        reasons.length == 1
        reasons[0].holdTypeEnumId == "OhtCredit"
    }
})

feature("a warn policy approves with a warning, and a customer without a policy approves as before", {
    when() {
        policy(warnedCustomer, {creditLimit: 20, actionEnumId: "CpaWarn"})
        const warnedOrder = order(warnedCustomer)
        login(approver)
        const messages = svc("mantle.order.OrderServices.approve#Order", {orderId: warnedOrder}).creditWarning
        login("john.doe")
        const other = prefix + "_PLAIN"
        svc("create#mantle.party.Party", {partyId: other, partyTypeEnumId: "PtyOrganization"})
        svc("create#mantle.party.PartyRole", {partyId: other, roleTypeId: "Customer"})
        const plainOrder = order(other)
        login(approver)
        const plain = svc("mantle.order.OrderServices.approve#Order", {orderId: plainOrder})
        return {warned: status(warnedOrder), messages, plain, plainStatus: status(plainOrder)}
    },
    then({warned, messages, plain, plainStatus}) {
        warned == "OrderApproved"
        messages.includes("Credit warning")
        plain.creditHeld == false
        plainStatus == "OrderApproved"
    }
})

feature("a second hold reason keeps the order held until it is released too", {
    when() {
        const orderId = order(f.customer)
        login(approver)
        svc("mantle.order.OrderServices.approve#Order", {orderId})
        const manual = svc("mantle.order.OrderServices.hold#Order", {
            orderId,
            holdTypeEnumId: "OhtManual",
            holdComment: "Address check"
        })
        login(f.users.ar)
        const noManual = refused("mantle.order.OrderServices.hold#Order", {orderId, holdTypeEnumId: "OhtManual"})
        login(credit)
        const creditReleased = svc("mantle.account.CreditServices.release#CreditHold", {orderId, reason: "Approved limit"})
        const stillHeld = status(orderId)
        const noManualRelease = refused("mantle.order.OrderServices.release#OrderHold", {
            orderHoldReasonId: manual.orderHoldReasonId,
            releaseComment: "Checked"
        })
        login(approver)
        const released = svc("mantle.order.OrderServices.release#OrderHold", {
            orderHoldReasonId: manual.orderHoldReasonId,
            releaseComment: "Address checked"
        })
        return {creditReleased, stillHeld, noManual, noManualRelease, released, status: status(orderId)}
    },
    then({creditReleased, stillHeld, noManual, noManualRelease, released, status}) {
        creditReleased.stillHeld == true
        stillHeld == "OrderHold"
        noManual.includes("PERMISSION_DENIED")
        noManualRelease.includes("PERMISSION_DENIED")
        released.stillHeld == false
        status == "OrderApproved"
    }
})
