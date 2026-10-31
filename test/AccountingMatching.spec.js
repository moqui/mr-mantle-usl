// Bill matching: a bill's lines matched to purchase order lines and accepted receipts under the organization's match
// policy, written as billing links; refusals of excess and already-billed quantity; the match exception hold; stale
// matches re-evaluated by the job without releasing a hold; quarantine left out; and the legacy backfill. Standalone:
// spec-local organization, suppliers and users.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingReceivablesFixtures.js")
const svc = (name, p) => helper().call(name, p)
const match = (name, p) => helper().call("mantle.account.InvoiceMatchServices." + name, p)
const refused = (name, p) => helper().rejected(name, p)
const one = (entity, key) => helper().lib.one(entity, key)
const rows = (entity, key) => helper().lib.rows(entity, key)
const prefix = "MATCH"
const org = prefix + "_ORG",
    supplier = prefix + "_SUPPLIER",
    legacySupplier = prefix + "_LEGACY",
    facility = prefix + "_WH",
    product = "DEMO_1_1"
const users = {}
const ids = {}

function party(partyId, name, roleTypeId) {
    svc("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
    svc("create#mantle.party.Organization", {partyId, organizationName: name})
    svc("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
function user(kind, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    users[kind] = id
    svc("create#moqui.security.UserGroup", {userGroupId: id, description: "Matching " + kind})
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
        toPartyId: org,
        relationshipTypeEnumId: "PrtAgent",
        fromDate: 0
    })
}
// An approved purchase order of the product from a supplier.
function purchase(vendorPartyId, quantity, unitAmount) {
    const order = svc("mantle.order.OrderServices.create#Order", {
        customerPartyId: org,
        vendorPartyId,
        currencyUomId: "USD",
        facilityId: facility
    })
    const item = svc("mantle.order.OrderServices.add#OrderProductQuantity", {
        orderId: order.orderId,
        orderPartSeqId: order.orderPartSeqId,
        productId: product,
        quantity,
        unitAmount,
        itemTypeEnumId: "ItemInventory"
    })
    svc("mantle.order.OrderServices.place#Order", {orderId: order.orderId})
    svc("mantle.order.OrderServices.approve#Order", {orderId: order.orderId})
    return {orderId: order.orderId, orderItemSeqId: item.orderItemSeqId}
}
// A delivery of the order's product, received with the quantity accepted; its receipt.
function deliver(orderId, accepted) {
    const shipment = svc("mantle.shipment.ShipmentServices.create#OrderPartShipment", {
        orderId,
        orderPartSeqId: "01",
        destinationFacilityId: facility
    })
    for (const source of rows("mantle.shipment.ShipmentItemSource", {shipmentId: shipment.shipmentId}))
        svc("update#mantle.shipment.ShipmentItemSource", {
            shipmentItemSourceId: source.shipmentItemSourceId,
            quantity: accepted,
            quantityNotHandled: accepted
        })
    svc("update#mantle.shipment.ShipmentItem", {shipmentId: shipment.shipmentId, productId: product, quantity: accepted})
    svc("mantle.shipment.ShipmentServices.ship#Shipment", {shipmentId: shipment.shipmentId})
    svc("mantle.shipment.ShipmentServices.receive#ShipmentProduct", {
        shipmentId: shipment.shipmentId,
        productId: product,
        quantityAccepted: accepted,
        quantityRejected: 0,
        facilityId: facility
    })
    svc("mantle.shipment.ShipmentServices.deliver#Shipment", {shipmentId: shipment.shipmentId})
    return rows("mantle.product.receipt.AssetReceipt", {shipmentId: shipment.shipmentId})[0]
}
// A supplier's bill taken in by AP, with one product line.
function bill(reference, quantity, amount, supplierPartyId = supplier) {
    login(users.ap)
    const invoiceId = svc("mantle.account.InvoiceServices.import#Bill", {
        organizationPartyId: org,
        supplierPartyId,
        referenceNumber: reference
    }).invoiceId
    login("john.doe")
    svc("mantle.account.InvoiceServices.create#InvoiceItem", {
        invoiceId,
        itemTypeEnumId: "ItemInventory",
        productId: product,
        quantity,
        amount
    })
    return invoiceId
}
function allocation(source, receipt, quantity, invoiceItemSeqId = "01") {
    return {
        invoiceItemSeqId,
        orderId: source.orderId,
        orderItemSeqId: source.orderItemSeqId,
        assetReceiptId: receipt?.assetReceiptId || null,
        quantity: String(quantity)
    }
}
function lineSeq(invoiceId) {
    return rows("mantle.account.invoice.InvoiceItem", {invoiceId})[0].invoiceItemSeqId
}
function openHolds(invoiceId) {
    return rows("mantle.account.invoice.InvoiceHold", {invoiceId}).filter(row => !row.releasedDate)
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        party(org, "Matching organization", "OrgInternal")
        svc("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        svc("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
            organizationPartyId: org,
            filterDate: ec.user.nowTimestamp
        })
        // receipts do not bill themselves here: bills come from the supplier and are matched
        svc("update#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: org, receiptInvoiceSelfBilledOnly: "Y"})
        party(supplier, "Matching supplier", "Supplier")
        party(legacySupplier, "Legacy supplier", "Supplier")
        svc("create#mantle.facility.Facility", {facilityId: facility, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        user("ap", ["PAYABLE_EDIT", "PAYABLE_VIEW", "PAYABLE_IMPORT", "INVOICE_HOLD"])
        user("matcher", ["INVOICE_MATCH", "PAYABLE_VIEW"])
        user("reader", ["PAYABLE_VIEW"])
        user("approver", ["ACCOUNTING_VIEW", "INVOICE_APPROVE", "INVOICE_HOLD_RELEASE"])
        user("admin", ["ACCOUNTING_ADMIN"])
        ids.po = purchase(supplier, 10, 5)
        ids.receipt1 = deliver(ids.po.orderId, 6)
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    }
})

feature("the match policy is effective-dated rows that only finance administration changes", {
    when() {
        const request = {
            organizationPartyId: org,
            billBasisEnumId: "ImbReceived",
            priceTolerancePercent: 2,
            varianceActionEnumId: "ImaHold",
            fromDate: new Date(Number(ec.user.nowTimestamp) - 3600000),
            changeReason: "Three-way, 2% on price"
        }
        login(users.matcher)
        const denied = refused("mantle.account.InvoiceMatchServices.store#MatchPolicy", request)
        login(users.admin)
        const first = match("store#MatchPolicy", request)
        const same = match("store#MatchPolicy", request)
        const earlier = refused(
            "mantle.account.InvoiceMatchServices.store#MatchPolicy",
            Object.assign({}, request, {priceTolerancePercent: 3, fromDate: new Date(Number(ec.user.nowTimestamp) - 7200000)})
        )
        const override = match("store#MatchPolicy", {
            organizationPartyId: org,
            productId: "DEMO_3_1",
            billBasisEnumId: "ImbOrdered",
            receiptRequired: "N",
            changeReason: "Drop-shipped"
        })
        match("end#MatchPolicy", {invoiceMatchPolicyId: override.invoiceMatchPolicyId, changeReason: "No longer drop-shipped"})
        login(users.matcher)
        const listed = match("get#MatchPolicies", {organizationPartyId: org}).policyRows
        ids.policyId = first.invoiceMatchPolicyId
        return {denied, first, same, earlier, listed}
    },
    then({denied, first, same, earlier, listed}) {
        denied.includes("PERMISSION_DENIED")
        first.changed == true
        same.changed == false
        same.invoiceMatchPolicyId == first.invoiceMatchPolicyId
        earlier.includes("POLICY_OVERLAP")
        listed.length == 1
        listed[0].scopeText == "Organization"
        listed[0].inEffect == true
    }
})

feature("a bill against a partial accepted receipt matches; excess and already-billed quantity is refused", {
    when() {
        ids.billA = bill("MATCH-A", 6, 5)
        login(users.reader)
        const proposal = match("evaluate#InvoiceMatch", {invoiceId: ids.billA})
        login(users.matcher)
        const allocations = [allocation(ids.po, ids.receipt1, 6, lineSeq(ids.billA))]
        const readerApply = (() => {
            login(users.reader)
            return refused("mantle.account.InvoiceMatchServices.apply#InvoiceMatch", {
                invoiceId: ids.billA,
                allocationList: allocations
            })
        })()
        login(users.matcher)
        const applied = match("apply#InvoiceMatch", {
            invoiceId: ids.billA,
            allocationList: allocations,
            operationKey: "MATCH-A-1"
        })
        const retried = match("apply#InvoiceMatch", {
            invoiceId: ids.billA,
            allocationList: allocations,
            operationKey: "MATCH-A-1"
        })
        const links = rows("mantle.order.OrderItemBilling", {invoiceId: ids.billA})
        // a second delivery of three: four is more than is left, and the first receipt is billed
        ids.receipt2 = deliver(ids.po.orderId, 3)
        login(users.matcher)
        ids.billB = bill("MATCH-B", 4, 5)
        login(users.matcher)
        const excess = refused("mantle.account.InvoiceMatchServices.apply#InvoiceMatch", {
            invoiceId: ids.billB,
            allocationList: [allocation(ids.po, ids.receipt2, 4, lineSeq(ids.billB))]
        })
        const billed = refused("mantle.account.InvoiceMatchServices.apply#InvoiceMatch", {
            invoiceId: ids.billB,
            allocationList: [allocation(ids.po, ids.receipt1, 2, lineSeq(ids.billB))]
        })
        return {proposal, readerApply, applied, retried, links, excess, billed}
    },
    then({proposal, readerApply, applied, retried, links, excess, billed}) {
        proposal.resultEnumId == "ImrMatched"
        proposal.sourceRows.length == 1
        proposal.sourceRows[0].assetReceiptId == ids.receipt1.assetReceiptId
        proposal.sourceRows[0].quantity == 6
        proposal.inspectionCheck == "unavailable"
        proposal.matchCapabilities.canApply == false
        readerApply.includes("PERMISSION_DENIED")
        applied.resultEnumId == "ImrMatched"
        applied.invoiceHoldId == null
        retried.alreadyApplied == true
        retried.invoiceMatchId == applied.invoiceMatchId
        links.length == 1
        links[0].quantity == 6
        links[0].assetReceiptId == ids.receipt1.assetReceiptId
        one("mantle.product.receipt.AssetReceipt", {assetReceiptId: ids.receipt1.assetReceiptId}).invoiceId == ids.billA
        one("mantle.account.invoice.InvoiceMatchLine", {invoiceMatchId: applied.invoiceMatchId, invoiceMatchLineSeqId: "00001"})
            .invoiceMatchPolicyId == ids.policyId
        excess.includes("QUANTITY_EXCESS")
        billed.includes("ALREADY_BILLED")
    }
})

feature("a price outside tolerance holds the bill, naming the rule, and the bill is not approved", {
    when() {
        ids.billD = bill("MATCH-D", 3, "5.50")
        login(users.matcher)
        const allocations = [allocation(ids.po, ids.receipt2, 3, lineSeq(ids.billD))]
        const evaluated = match("evaluate#InvoiceMatch", {invoiceId: ids.billD, allocationList: allocations})
        const applied = match("apply#InvoiceMatch", {invoiceId: ids.billD, allocationList: allocations})
        const holds = openHolds(ids.billD)
        login(users.approver)
        const approve = refused("mantle.account.InvoiceServices.approve#Payable", {
            invoiceId: ids.billD,
            lastUpdatedStamp: one("mantle.account.invoice.Invoice", {invoiceId: ids.billD}).lastUpdatedStamp
        })
        return {evaluated, applied, holds, approve}
    },
    then({evaluated, applied, holds, approve}) {
        evaluated.exceptionRows.some(row => row.exceptionEnumId == "MePriceVariance" && row.holds)
        applied.resultEnumId == "ImrException"
        applied.invoiceHoldId != null
        holds.length == 1
        holds[0].holdReasonEnumId == "IhrMatchException"
        holds[0].holdComment.includes("match policy " + ids.policyId)
        approve.includes("INVOICE_HELD")
    }
})

feature("a changed bill line or receipt marks the match stale; the job re-evaluates it and releases no hold", {
    when() {
        // bill D's line corrected to the order price: within tolerance now, but its hold stays
        svc("mantle.account.InvoiceServices.update#InvoiceItem", {
            invoiceId: ids.billD,
            invoiceItemSeqId: lineSeq(ids.billD),
            amount: 5
        })
        const staleD = one("mantle.account.invoice.InvoiceMatch", {invoiceId: ids.billD, statusId: "ImApplied"})
        const first = match("run#MatchReevaluation", {})
        const evaluatedD = one("mantle.account.invoice.InvoiceMatch", {invoiceMatchId: staleD.invoiceMatchId})
        // the first receipt corrected to four: bill A's six no longer has its source
        svc("update#mantle.product.receipt.AssetReceipt", {assetReceiptId: ids.receipt1.assetReceiptId, quantityAccepted: 4})
        const staleA = one("mantle.account.invoice.InvoiceMatch", {invoiceId: ids.billA, statusId: "ImApplied"})
        const second = match("run#MatchReevaluation", {})
        const evaluatedA = one("mantle.account.invoice.InvoiceMatch", {invoiceMatchId: staleA.invoiceMatchId})
        return {staleD, first, evaluatedD, staleA, second, evaluatedA, holdsA: openHolds(ids.billA), holdsD: openHolds(ids.billD)}
    },
    then({staleD, first, evaluatedD, staleA, second, evaluatedA, holdsA, holdsD}) {
        staleD.staleDate != null
        first.failedCount == 0
        first.resultList.some(row => row.invoiceId == ids.billD && row.resultEnumId == "ImrMatched")
        evaluatedD.staleDate == null
        evaluatedD.resultEnumId == "ImrMatched"
        holdsD.length == 1
        staleA.staleDate != null
        second.failedCount == 0
        second.resultList.some(row => row.invoiceId == ids.billA && row.resultEnumId == "ImrException")
        evaluatedA.staleDate == null
        evaluatedA.resultText.includes("Source changed")
        holdsA.length == 1
        holdsA[0].holdReasonEnumId == "IhrMatchException"
    }
})

feature("unapplying reverses the billing link and the receipt, and the bill's hold stays", {
    when() {
        login(users.matcher)
        const unapplied = match("unapply#InvoiceMatch", {invoiceId: ids.billD})
        const links = rows("mantle.order.OrderItemBilling", {invoiceId: ids.billD})
        const again = refused("mantle.account.InvoiceMatchServices.unapply#InvoiceMatch", {invoiceId: ids.billD})
        return {unapplied, links, again}
    },
    then({unapplied, links, again}) {
        one("mantle.account.invoice.InvoiceMatch", {invoiceMatchId: unapplied.invoiceMatchId}).statusId == "ImUnapplied"
        links.every(row => toDecimal(row.quantity).isZero())
        one("mantle.product.receipt.AssetReceipt", {assetReceiptId: ids.receipt2.assetReceiptId}).invoiceId == null
        again.includes("MATCH_UNAVAILABLE")
        openHolds(ids.billD).length == 1
    }
})

feature("quantity in quarantine is left out of the match", {
    when() {
        const po = purchase(supplier, 5, 5)
        const receipt = deliver(po.orderId, 5)
        svc("update#mantle.product.asset.Asset", {assetId: receipt.assetId, statusId: "AstQuarantine"})
        const billId = bill("MATCH-Q", 5, 5)
        login(users.matcher)
        return match("evaluate#InvoiceMatch", {
            invoiceId: billId,
            allocationList: [allocation(po, receipt, 5, lineSeq(billId))]
        })
    },
    then(evaluated) {
        evaluated.sourceRows[0].heldQuantity == 5
        evaluated.sourceRows[0].refusedReason == "MISSING_RECEIPT"
        evaluated.exceptionRows.some(row => row.exceptionEnumId == "MeInspectionHold")
        evaluated.resultEnumId == "ImrException"
    }
})

feature("the legacy backfill links unambiguous evidence and names an ambiguous line, matching no unexplained balance", {
    when() {
        const first = purchase(legacySupplier, 4, 5)
        const second = purchase(legacySupplier, 4, 5)
        const firstReceipt = deliver(first.orderId, 4)
        const secondReceipt = deliver(second.orderId, 4)
        // a bill with Mantle's billing link for three of its five
        const linked = bill("LEGACY-1", 5, 5, legacySupplier)
        svc("create#mantle.order.OrderItemBilling", {
            orderId: first.orderId,
            orderItemSeqId: first.orderItemSeqId,
            invoiceId: linked,
            invoiceItemSeqId: lineSeq(linked),
            assetReceiptId: firstReceipt.assetReceiptId,
            quantity: 3,
            amount: 5
        })
        // a bill whose receipts are of two order lines
        const ambiguous = bill("LEGACY-2", 8, 5, legacySupplier)
        for (const receipt of [firstReceipt, secondReceipt])
            svc("update#mantle.product.receipt.AssetReceipt", {
                assetReceiptId: receipt.assetReceiptId,
                invoiceId: ambiguous,
                invoiceItemSeqId: lineSeq(ambiguous)
            })
        const none = bill("LEGACY-3", 2, 5, legacySupplier)
        login(users.matcher)
        const preview = match("preview#LegacyMatches", {organizationPartyId: org, supplierPartyId: legacySupplier})
        const applied = match("apply#LegacyMatches", {organizationPartyId: org, supplierPartyId: legacySupplier})
        const linkedMatch = one("mantle.account.invoice.InvoiceMatch", {invoiceId: linked, statusId: "ImApplied"})
        const ambiguousMatch = one("mantle.account.invoice.InvoiceMatch", {invoiceId: ambiguous, statusId: "ImApplied"})
        const noneMatch = one("mantle.account.invoice.InvoiceMatch", {invoiceId: none, statusId: "ImApplied"})
        return {preview, applied, linked, ambiguous, linkedMatch, ambiguousMatch, noneMatch}
    },
    then({preview, applied, linked, ambiguous, linkedMatch, ambiguousMatch, noneMatch}) {
        preview.linkCount == 1
        preview.ambiguousCount == 1
        preview.noEvidenceCount == 1
        preview.unexplainedCount == 1
        preview.previewRows.some(
            row => row.invoiceId == ambiguous && row.result == "ambiguous" && row.resultText.includes("2 order lines")
        )
        applied.failedCount == 0
        applied.matchedCount == 2
        linkedMatch.isLegacy == "Y"
        linkedMatch.resultEnumId == "ImrMatched"
        rows("mantle.account.invoice.InvoiceMatchLine", {invoiceMatchId: linkedMatch.invoiceMatchId}).length == 1
        rows("mantle.order.OrderItemBilling", {invoiceId: linked})[0].quantity == 3
        ambiguousMatch.resultEnumId == "ImrException"
        rows("mantle.account.invoice.InvoiceMatchLine", {invoiceMatchId: ambiguousMatch.invoiceMatchId})[0].exceptionEnumId ==
            "MeAmbiguous"
        openHolds(ambiguous).length == 0
        noneMatch == null
    }
})
