// Returns and order changes (D11, D3): with the organization's returnSettlementRequired, approval responds to nothing,
// receive#ReturnItems records what arrived, and settle#Return credits, refunds or replaces only what was received, within
// the caps, after a preview; a receiptless credit needs a reason and an approver; a supplier return makes the payable
// credit. With salesInvoiceFinalizedAtShip the pack invoice stays in process until ship, a reopened package takes its
// lines off it, and a captured order payment is refunded through Mantle's refund. Standalone: spec-local organization,
// parties, stock and users.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingReceivablesFixtures.js")
const svc = (name, p) => helper().call(name, p)
const refused = (name, p) => helper().rejected(name, p)
const one = (entity, key) => helper().lib.one(entity, key)
const rows = (entity, key) => helper().lib.rows(entity, key)
const R = "mantle.order.ReturnServices."
const prefix = "RETS"
const org = prefix + "_ORG",
    customer = prefix + "_CUST",
    supplier = prefix + "_SUPP",
    facility = prefix + "_WH",
    productA = "DEMO_1_2",
    productB = "DEMO_2_1"
const users = {}
const ids = {}
let keySeq = 0
const key = () => prefix + "-" + ++keySeq

function party(partyId, name, roleTypeId) {
    svc("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
    svc("create#mantle.party.Organization", {partyId, organizationName: name})
    svc("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
function user(kind, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    users[kind] = id
    svc("create#moqui.security.UserGroup", {userGroupId: id, description: "Returns " + kind})
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
function preference(fields) {
    svc("update#mantle.ledger.config.PartyAcctgPreference", Object.assign({organizationPartyId: org}, fields))
}
// A sales order of the lines, paid by a delivered check for its total, placed and approved.
function sale(lines) {
    login("john.doe")
    const order = svc("mantle.order.OrderServices.create#Order", {
        vendorPartyId: org,
        customerPartyId: customer,
        facilityId: facility
    })
    for (const [productId, quantity, unitAmount] of lines)
        svc("mantle.order.OrderServices.add#OrderProductQuantity", {
            orderId: order.orderId,
            orderPartSeqId: order.orderPartSeqId,
            productId,
            quantity,
            unitAmount
        })
    const payment = svc("mantle.order.OrderServices.add#OrderPartPayment", {
        orderId: order.orderId,
        orderPartSeqId: order.orderPartSeqId,
        paymentInstrumentEnumId: "PiCompanyCheck"
    })
    svc("mantle.order.OrderServices.place#Order", {orderId: order.orderId})
    svc("mantle.order.OrderServices.approve#Order", {orderId: order.orderId})
    svc("update#mantle.account.payment.Payment", {
        paymentId: payment.paymentId,
        statusId: "PmntDelivered",
        effectiveDate: ec.user.nowTimestamp
    })
    return {orderId: order.orderId, paymentId: payment.paymentId}
}
function itemSeq(orderId, productId) {
    return rows("mantle.order.OrderItem", {orderId}).find(row => row.productId === productId).orderItemSeqId
}
// A return of the order's lines, requested and approved by Customer Service.
function customerReturn(orderId, lines) {
    login("john.doe")
    const returnId = svc(R + "create#ReturnFromOrder", {orderId, orderPartSeqId: "01"}).returnId
    for (const [productId, returnQuantity, returnResponseEnumId] of lines)
        svc(R + "add#OrderItemToReturn", {
            returnId,
            orderId,
            orderItemSeqId: itemSeq(orderId, productId),
            returnQuantity,
            returnReasonEnumId: "RrsnDefective",
            returnResponseEnumId
        })
    svc(R + "approve#Return", {returnId})
    return returnId
}
function returnSeq(returnId, productId) {
    return rows("mantle.order.return.ReturnItem", {returnId}).find(row => row.productId === productId).returnItemSeqId
}
function returnShipment(returnId) {
    return rows("mantle.shipment.ShipmentItemSource", {returnId})[0].shipmentId
}
function receiveBox(returnId, productId, accepted, rejected = 0) {
    login(users.receiver)
    return svc("mantle.shipment.WarehouseTaskServices.receive#ReturnItems", {
        shipmentId: returnShipment(returnId),
        itemList: [
            {returnId, returnItemSeqId: returnSeq(returnId, productId), quantityAccepted: accepted, quantityRejected: rejected}
        ]
    })
}
function preview(returnId, lineList, extra = {}) {
    return svc(R + "preview#ReturnSettlement", Object.assign({returnId, lineList}, extra))
}
function settleRequest(returnId, lineList, extra = {}) {
    const previewed = preview(returnId, lineList, extra)
    return Object.assign({returnId, lineList, previewVersion: previewed.previewVersion, operationKey: key()}, extra)
}
function billings(returnId) {
    return rows("mantle.order.return.ReturnItemBilling", {returnId})
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        party(org, "Returns organization", "OrgInternal")
        svc("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        svc("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
            organizationPartyId: org,
            filterDate: ec.user.nowTimestamp
        })
        preference({returnSettlementRequired: "Y"})
        party(customer, "Returns customer", "Customer")
        party(supplier, "Returns supplier", "Supplier")
        svc("create#mantle.facility.Facility", {facilityId: facility, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        for (const productId of [productA, productB])
            svc("mantle.product.AssetServices.receive#Asset", {
                productId,
                facilityId: facility,
                ownerPartyId: org,
                quantity: 40,
                acquireCost: 8
            })
        user("receiver", ["STOCK_RECEIVE"])
        user("reader", ["RECEIVABLE_VIEW"])
        user("ar", ["RECEIVABLE_EDIT", "RECEIVABLE_VIEW"])
        user("treasury", ["RECEIVABLE_EDIT", "RECEIVABLE_VIEW", "PAYMENT_EDIT", "PAYMENT_VIEW"])
        user("approver", ["RECEIVABLE_EDIT", "RECEIVABLE_VIEW", "RETURN_CREDIT_APPROVE"])
        user("ap", ["PAYABLE_EDIT", "PAYABLE_VIEW"])
        ids.sale = sale([
            [productA, 5, 20],
            [productB, 2, 20]
        ])
        login("john.doe")
        svc("mantle.shipment.ShipmentServices.ship#OrderPart", {orderId: ids.sale.orderId, orderPartSeqId: "01"})
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    }
})

feature("approving a return creates no credit, and receipt goes through receive#ReturnItems only under the flag", {
    when() {
        ids.returnA = customerReturn(ids.sale.orderId, [
            [productA, 3, "RrspCredit"],
            [productB, 2, "RrspRefund"]
        ])
        const afterApproval = {
            billings: billings(ids.returnA).length,
            header: one("mantle.order.return.ReturnHeader", {returnId: ids.returnA})
        }
        login("john.doe")
        preference({returnSettlementRequired: "N"})
        login(users.receiver)
        const off = refused("mantle.shipment.WarehouseTaskServices.receive#ReturnItems", {
            shipmentId: returnShipment(ids.returnA),
            itemList: [{returnId: ids.returnA, returnItemSeqId: returnSeq(ids.returnA, productA), quantityAccepted: 1}]
        })
        login("john.doe")
        preference({returnSettlementRequired: "Y"})
        login(users.ar)
        const noStock = refused("mantle.shipment.WarehouseTaskServices.receive#ReturnItems", {
            shipmentId: returnShipment(ids.returnA),
            itemList: [{returnId: ids.returnA, returnItemSeqId: returnSeq(ids.returnA, productA), quantityAccepted: 1}]
        })
        login(users.receiver)
        const excess = refused("mantle.shipment.WarehouseTaskServices.receive#ReturnItems", {
            shipmentId: returnShipment(ids.returnA),
            itemList: [{returnId: ids.returnA, returnItemSeqId: returnSeq(ids.returnA, productA), quantityAccepted: 4}]
        })
        return {afterApproval, off, noStock, excess}
    },
    then({afterApproval, off, noStock, excess}) {
        afterApproval.billings == 0
        afterApproval.header.statusId == "ReturnApproved"
        off.includes("RETURN_SETTLEMENT_OFF")
        noStock.includes("PERMISSION_DENIED")
        excess.includes("RECEIPT_EXCEEDS_RETURN")
    }
})

feature("a partial receipt credits only what arrived, and a second box is credited later", {
    when() {
        // the first box: one unit accepted, one rejected at the dock; both are received
        const first = receiveBox(ids.returnA, productA, 1, 1)
        const seqA = returnSeq(ids.returnA, productA)
        login(users.reader)
        const read = preview(ids.returnA, [{returnItemSeqId: seqA}])
        const readerSettle = refused(R + "settle#Return", settleRequest(ids.returnA, [{returnItemSeqId: seqA, quantity: 1}]))
        login(users.ar)
        const over = refused(R + "preview#ReturnSettlement", {
            returnId: ids.returnA,
            lineList: [{returnItemSeqId: seqA, quantity: 3}]
        })
        const stale = settleRequest(ids.returnA, [{returnItemSeqId: seqA, quantity: 1}])
        const request = settleRequest(ids.returnA, [{returnItemSeqId: seqA, quantity: 1}])
        const settled = svc(R + "settle#Return", request)
        const retry = svc(R + "settle#Return", request)
        const changed = refused(R + "settle#Return", stale)
        const rest = svc(R + "settle#Return", settleRequest(ids.returnA, [{returnItemSeqId: seqA}]))
        const afterFirstBox = billings(ids.returnA).filter(row => row.returnItemSeqId === seqA)
        // the second box, later
        receiveBox(ids.returnA, productA, 1)
        login(users.ar)
        const second = svc(R + "settle#Return", settleRequest(ids.returnA, [{returnItemSeqId: seqA}]))
        const item = one("mantle.order.return.ReturnItem", {returnId: ids.returnA, returnItemSeqId: seqA})
        return {first, read, readerSettle, over, changed, settled, retry, rest, afterFirstBox, second, item}
    },
    then({first, read, readerSettle, over, changed, settled, retry, rest, afterFirstBox, second, item}) {
        first.receivedItems[0].receivedQuantity == 2
        first.receivedItems[0].statusId == "ReturnApproved"
        read.itemRows[0].eligibleQuantity == 2
        read.reasonCode == "FORBIDDEN"
        readerSettle.includes("FORBIDDEN")
        over.includes("CREDIT_CAP_EXCEEDED")
        settled.resultCode == "SETTLED"
        settled.creditInvoiceIds.length == 1
        retry.alreadyApplied == true
        retry.creditInvoiceIds[0] == settled.creditInvoiceIds[0]
        changed.includes("RECEIPT_CHANGED")
        rest.settledLines[0].quantity == "1"
        afterFirstBox.length == 2
        afterFirstBox[0].originalInvoiceId != null
        afterFirstBox[0].assetReceiptId != null
        afterFirstBox[0].settledByUserId == users.ar
        second.settledLines[0].quantity == "1"
        item.receivedQuantity == 3
        item.statusId == "ReturnCompleted"
    }
})

feature("a refund goes back to the original payment and stays within what was paid", {
    when() {
        const seqB = returnSeq(ids.returnA, productB)
        receiveBox(ids.returnA, productB, 2)
        login("john.doe")
        // another refund of the original leaves 30 of its 140
        const other = svc("mantle.account.PaymentServices.create#RefundPayment", {
            paymentId: ids.sale.paymentId,
            amount: 110,
            statusId: "PmntPromised"
        })
        login(users.treasury)
        const capped = preview(ids.returnA, [{returnItemSeqId: seqB}])
        login("john.doe")
        svc("update#mantle.account.payment.Payment", {paymentId: other.paymentId, statusId: "PmntCancelled"})
        login(users.ar)
        const noTreasury = preview(ids.returnA, [{returnItemSeqId: seqB}])
        login(users.treasury)
        const refunded = svc(R + "settle#Return", settleRequest(ids.returnA, [{returnItemSeqId: seqB}]))
        const refund = one("mantle.account.payment.Payment", {paymentId: refunded.refundPaymentId})
        const memo = one("mantle.account.invoice.Invoice", {invoiceId: refunded.creditInvoiceIds[0]})
        const header = one("mantle.order.return.ReturnHeader", {returnId: ids.returnA})
        return {capped, noTreasury, refunded, refund, memo, header}
    },
    then({capped, noTreasury, refunded, refund, memo, header}) {
        capped.reasonCode == "CREDIT_CAP_EXCEEDED"
        noTreasury.reasonCode == "FORBIDDEN"
        refunded.resultCode == "SETTLED"
        refund.refundForPaymentId == ids.sale.paymentId
        refund.statusId == "PmntDelivered"
        refund.amount == 40
        refund.forInvoiceId == refunded.creditInvoiceIds[0]
        memo.unpaidTotal == 0
        memo.financeDirection == "receivable"
        header.statusId == "ReturnCompleted"
    }
})

feature("a credit without receipt needs a reason and an approver", {
    when() {
        ids.returnB = customerReturn(ids.sale.orderId, [[productA, 1, "RrspCredit"]])
        const seq = returnSeq(ids.returnB, productA)
        const lines = [{returnItemSeqId: seq}]
        login(users.ar)
        const notApprover = preview(ids.returnB, lines, {receiptless: true, reason: "Lost by the carrier"})
        const notReceived = preview(ids.returnB, lines)
        login(users.approver)
        const noReason = preview(ids.returnB, lines, {receiptless: true})
        const settled = svc(
            R + "settle#Return",
            settleRequest(ids.returnB, lines, {receiptless: true, reason: "Lost by the carrier"})
        )
        const billing = billings(ids.returnB)[0]
        const item = one("mantle.order.return.ReturnItem", {returnId: ids.returnB, returnItemSeqId: seq})
        const header = one("mantle.order.return.ReturnHeader", {returnId: ids.returnB})
        return {notApprover, notReceived, noReason, settled, billing, item, header}
    },
    then({notApprover, notReceived, noReason, settled, billing, item, header}) {
        notApprover.reasonCode == "FORBIDDEN"
        notReceived.reasonCode == "NOTHING_TO_SETTLE"
        noReason.reasonCode == "REASON_REQUIRED"
        settled.resultCode == "SETTLED"
        billing.receiptless == "Y"
        billing.approvedByUserId == users.approver
        billing.assetReceiptId == null
        item.statusId == "ReturnCompleted"
        header.statusId == "ReturnCompleted"
    }
})

feature("a supplier return creates the payable credit for the billed quantity", {
    when() {
        login("john.doe")
        const order = svc("mantle.order.OrderServices.create#Order", {
            customerPartyId: org,
            vendorPartyId: supplier,
            currencyUomId: "USD",
            facilityId: facility
        })
        const line = svc("mantle.order.OrderServices.add#OrderProductQuantity", {
            orderId: order.orderId,
            orderPartSeqId: order.orderPartSeqId,
            productId: productA,
            quantity: 4,
            unitAmount: 7,
            itemTypeEnumId: "ItemInventory"
        })
        svc("mantle.order.OrderServices.place#Order", {orderId: order.orderId})
        svc("mantle.order.OrderServices.approve#Order", {orderId: order.orderId})
        const shipment = svc("mantle.shipment.ShipmentServices.create#OrderPartShipment", {
            orderId: order.orderId,
            orderPartSeqId: "01",
            destinationFacilityId: facility
        })
        svc("mantle.shipment.ShipmentServices.ship#Shipment", {shipmentId: shipment.shipmentId})
        svc("mantle.shipment.ShipmentServices.receive#ShipmentProduct", {
            shipmentId: shipment.shipmentId,
            productId: productA,
            quantityAccepted: 4,
            facilityId: facility
        })
        svc("mantle.shipment.ShipmentServices.deliver#Shipment", {shipmentId: shipment.shipmentId})
        const billing = rows("mantle.order.OrderItemBilling", {orderId: order.orderId, orderItemSeqId: line.orderItemSeqId})[0]
        svc("update#mantle.account.invoice.Invoice", {invoiceId: billing.invoiceId, statusId: "InvoiceApproved"})
        const returnId = svc(R + "create#ReturnFromOrder", {orderId: order.orderId, orderPartSeqId: "01"}).returnId
        svc(R + "add#OrderItemToReturn", {
            returnId,
            orderId: order.orderId,
            orderItemSeqId: line.orderItemSeqId,
            returnQuantity: 2,
            returnReasonEnumId: "RrsnDefective",
            returnResponseEnumId: "RrspCredit"
        })
        svc(R + "approve#Return", {returnId})
        login(users.ap)
        const beforeShipped = preview(returnId, [])
        login("john.doe")
        svc(R + "update#ReturnStatus", {returnId, statusId: "ReturnShipped"})
        login(users.ar)
        const arUser = refused(R + "preview#ReturnSettlement", {returnId})
        login(users.ap)
        const settled = svc(R + "settle#Return", settleRequest(returnId, []))
        const credit = one("mantle.account.invoice.Invoice", {invoiceId: settled.creditInvoiceIds[0]})
        const link = billings(returnId)[0]
        const header = one("mantle.order.return.ReturnHeader", {returnId})
        return {beforeShipped, arUser, settled, credit, link, billing, header}
    },
    then({beforeShipped, arUser, settled, credit, link, billing, header}) {
        beforeShipped.reasonCode == "NOTHING_TO_SETTLE"
        arUser.includes("FORBIDDEN")
        settled.resultCode == "SETTLED"
        credit.creditForInvoiceId == billing.invoiceId
        credit.financeDirection == "payable"
        credit.toPartyId == supplier
        credit.invoiceTotal == 14
        link.originalInvoiceId == billing.invoiceId
        link.quantity == 2
        link.assetReceiptId != null
        header.statusId == "ReturnCompleted"
    }
})

feature("the pack invoice waits for ship, a reopened package leaves it, and a captured payment is refunded", {
    when() {
        login("john.doe")
        preference({salesInvoiceFinalizedAtShip: "Y"})
        const sold = sale([[productA, 2, 20]])
        const shipment = svc("mantle.shipment.ShipmentServices.create#OrderPartShipment", {
            orderId: sold.orderId,
            orderPartSeqId: "01"
        })
        svc("mantle.shipment.ShipmentServices.pack#ShipmentProduct", {
            productId: productA,
            quantity: 2,
            shipmentId: shipment.shipmentId
        })
        svc("mantle.shipment.ShipmentServices.pack#Shipment", {shipmentId: shipment.shipmentId})
        const packedInvoiceId = rows("mantle.order.OrderItemBilling", {shipmentId: shipment.shipmentId})[0].invoiceId
        const packed = one("mantle.account.invoice.Invoice", {invoiceId: packedInvoiceId})
        login(users.ar)
        const arRefund = refused("mantle.account.PaymentServices.refund#OrderPayment", {
            paymentId: sold.paymentId,
            amount: 10,
            reason: "Line removed",
            operationKey: key()
        })
        login(users.treasury)
        const refundRequest = {paymentId: sold.paymentId, amount: 10, reason: "Line removed", operationKey: key()}
        const refunded = svc("mantle.account.PaymentServices.refund#OrderPayment", refundRequest)
        const refundRetry = svc("mantle.account.PaymentServices.refund#OrderPayment", refundRequest)
        const released = svc("mantle.account.InvoiceServices.release#ShipmentDraftInvoice", {
            shipmentId: shipment.shipmentId,
            reason: "Package reopened",
            operationKey: key()
        })
        const afterRelease = one("mantle.account.invoice.Invoice", {invoiceId: packedInvoiceId})
        login("john.doe")
        svc("update#mantle.shipment.Shipment", {shipmentId: shipment.shipmentId, statusId: "ShipPicked"})
        svc("mantle.shipment.ShipmentServices.pack#Shipment", {shipmentId: shipment.shipmentId})
        const repackedInvoiceId = rows("mantle.order.OrderItemBilling", {shipmentId: shipment.shipmentId})[0].invoiceId
        svc("mantle.shipment.ShipmentServices.ship#Shipment", {shipmentId: shipment.shipmentId})
        const shipped = one("mantle.account.invoice.Invoice", {invoiceId: repackedInvoiceId})
        login(users.treasury)
        const late = refused("mantle.account.InvoiceServices.release#ShipmentDraftInvoice", {
            shipmentId: shipment.shipmentId,
            reason: "Too late"
        })
        login("john.doe")
        preference({salesInvoiceFinalizedAtShip: "N"})
        return {
            packed,
            arRefund,
            refunded,
            refundRetry,
            released,
            afterRelease,
            repackedInvoiceId,
            packedInvoiceId,
            shipped,
            late
        }
    },
    then({packed, arRefund, refunded, refundRetry, released, afterRelease, repackedInvoiceId, packedInvoiceId, shipped, late}) {
        packed.statusId == "InvoiceInProcess"
        packed.appliedPaymentsTotal == 0
        arRefund.includes("PERMISSION_DENIED")
        refunded.resultCode == "REFUNDED"
        refundRetry.alreadyApplied == true
        refundRetry.refundPaymentId == refunded.refundPaymentId
        released.releasedItemCount == 1
        released.cancelledInvoiceIdList.includes(packedInvoiceId)
        afterRelease.statusId == "InvoiceCancelled"
        repackedInvoiceId != packedInvoiceId
        shipped.statusId == "InvoiceFinalized"
        shipped.appliedPaymentsTotal == 30
        late.includes("SHIPMENT_SHIPPED")
    }
})
