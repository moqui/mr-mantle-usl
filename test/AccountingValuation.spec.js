// Inventory valuation and landed costs (AssetBookServices, InventoryReportServices): a freight bill line allocated by
// weight to two receipts raises the on-hand stock's cost and sends the issued share to cost of goods sold, once; the
// valuation then agrees with the inventory account, and still does after a revaluation, whose later issue posts at the
// new cost; a receipt without a cost basis and a ledger difference are listed, in the valuation and the close checklist;
// a count variance posts by its reason; the stock transactions report and cost data repair check their organization,
// period and permission. Spec-local organizations, products and users.
const fixtures = () => ec.resource.script("component://mr-mantle/test/AccountingSettlementFixtures.js")
const BOOK = "mantle.ledger.AssetBookServices.",
    REPORT = "mantle.product.InventoryReportServices."
let f, other
function asUser(userId, run) {
    login(userId)
    try {
        return run()
    } finally {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
function rejected(name, p) {
    return fixtures().rejected(name, p)
}
function one(entity, conditions) {
    return ec.entity.find(entity).condition(conditions).disableAuthz().one()
}
function list(entity, conditions) {
    return Array.from(ec.entity.find(entity).condition(conditions).disableAuthz().list()).map(r => r.getMap())
}
function product(productId, weight) {
    call("create#mantle.product.Product", {
        productId,
        productName: productId,
        productTypeEnumId: "PtAsset",
        assetTypeEnumId: "AstTpInventory",
        ownerPartyId: f.org,
        amountUomId: "OTH_ea"
    })
    if (weight)
        call("create#mantle.product.ProductUomDimension", {
            productId,
            uomDimensionTypeId: "Weight",
            value: weight,
            uomId: "WT_lb"
        })
}
function receive(productId, quantity, acquireCost) {
    const out = call("mantle.product.AssetServices.receive#Asset", {
        productId,
        facilityId: f.facilityId,
        quantity,
        ownerPartyId: f.org,
        acquireCost
    })
    call("update#mantle.product.asset.Asset", {assetId: out.assetId, acquireCostUomId: "USD"})
    return out
}
function issue(assetId, productId, quantity) {
    const out = call("create#mantle.product.issuance.AssetIssuance", {
        assetId,
        productId,
        quantity,
        issuedDate: ec.user.nowTimestamp
    })
    call("create#mantle.product.asset.AssetDetail", {
        assetId,
        productId,
        assetIssuanceId: out.assetIssuanceId,
        effectiveDate: ec.user.nowTimestamp,
        quantityOnHandDiff: -quantity,
        availableToPromiseDiff: -quantity
    })
    return out.assetIssuanceId
}
function entries(acctgTransId) {
    return list("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId})
}
function valuation(org = f.org) {
    return asUser(f.users.read, () => call(REPORT + "run#InventoryValuation", {organizationPartyId: org}))
}
function currentMonth(org) {
    const day = ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
    const text = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js").calendarDateText
    return list("mantle.party.time.TimePeriod", {partyId: org, timePeriodTypeId: "FiscalMonth"}).find(
        r => text(r.fromDate) <= day && text(r.thruDate) >= day
    ).timePeriodId
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const h = fixtures()
        f = h.fixtures("ACCT_P13_VAL")
        other = h.fixtures("ACCT_P13_OTHER")
        f.users.gl = h.user(f, "GL", ["ACCOUNTING_VIEW", "ACCOUNTING_GL_POST", "PRODUCT_COST_VIEW"])
        f.facilityId = "ACCT_P13_WH"
        call("create#mantle.facility.Facility", {
            facilityId: f.facilityId,
            facilityTypeEnumId: "FcTpWarehouse",
            ownerPartyId: f.org,
            facilityName: "Valuation warehouse"
        })
        // the general cost of goods sold account the organization's default names, assigned to it
        call("create#mantle.ledger.account.GlAccountOrganization", {
            organizationPartyId: f.org,
            glAccountId: "512000000",
            fromDate: 0
        })
        product("P13_WIDGET", 2)
        product("P13_GADGET", 4)
        product("P13_NOCOST", null)
        // two receipts: ten widgets at 5 (20 lb) and five gadgets at 20 (20 lb); four widgets are then sold
        f.widget = receive("P13_WIDGET", 10, 5)
        f.gadget = receive("P13_GADGET", 5, 20)
        f.widgetIssue = issue(f.widget.assetId, "P13_WIDGET", 4)
        // a freight bill of 36 from the carrier, approved and so posted to freight in
        f.billId = call("create#mantle.account.invoice.Invoice", {
            invoiceTypeEnumId: "InvoiceSales",
            fromPartyId: f.customer,
            toPartyId: f.org,
            statusId: "InvoiceIncoming",
            invoiceDate: f.timestamp,
            accountingDate: f.day,
            currencyUomId: "USD",
            draftedByUserId: ec.user.userId
        }).invoiceId
        call("mantle.account.InvoiceServices.create#InvoiceItem", {
            invoiceId: f.billId,
            invoiceItemSeqId: "01",
            itemTypeEnumId: "ItemShipping",
            quantity: "1",
            amount: "36",
            description: "Freight in"
        })
        call("update#mantle.account.invoice.Invoice", {invoiceId: f.billId, statusId: "InvoiceApproved"})
        // the revaluation offset account, and one for count variances by reason
        call("create#mantle.ledger.config.GlAccountTypeDefault", {
            organizationPartyId: f.org,
            glAccountTypeEnumId: "GatInventoryRevaluation",
            glAccountId: "525000000"
        })
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
})

let preview
feature("a freight line allocated by weight raises the on-hand cost and sends the sold share to cost of goods sold", {
    when() {
        const p = {
            invoiceId: f.billId,
            invoiceItemSeqId: "01",
            basisEnumId: "LcbWeight",
            assetReceiptIds: [f.widget.assetReceiptId, f.gadget.assetReceiptId].join(",")
        }
        const sources = asUser(f.users.gl, () => call(BOOK + "get#LandedCostSources", {invoiceId: f.billId}))
        preview = asUser(f.users.gl, () => call(BOOK + "preview#LandedCost", p))
        const post = Object.assign({}, p, {
            inputFingerprint: preview.inputFingerprint,
            operationKey: "P13-LANDED-1",
            changeReason: "Freight in on the October receipts"
        })
        const denied = asUser(f.users.read, () => rejected(BOOK + "post#LandedCost", post))
        const posted = asUser(f.users.gl, () => call(BOOK + "post#LandedCost", post))
        const again = asUser(f.users.gl, () => call(BOOK + "post#LandedCost", post))
        const twice = asUser(f.users.gl, () =>
            rejected(BOOK + "post#LandedCost", Object.assign({}, post, {operationKey: "P13-LANDED-2"}))
        )
        return {
            sources,
            denied,
            posted,
            again,
            twice,
            lines: entries(posted.acctgTransId),
            widget: one("mantle.product.asset.Asset", {assetId: f.widget.assetId}),
            gadget: one("mantle.product.asset.Asset", {assetId: f.gadget.assetId}),
            allocations: list("mantle.account.invoice.LandedCostAllocation", {invoiceId: f.billId})
        }
    },
    then({sources, denied, posted, again, twice, lines, widget, gadget, allocations}) {
        sources.chargeRows[0].eligible == true
        sources.chargeRows[0].chargeGlAccountId == "519100000"
        preview.complete == true
        preview.allocationRows.length == 2
        preview.totalAmount == 36
        preview.allocationRows.find(r => r.assetReceiptId == f.widget.assetReceiptId).onHandAmount == 10.8
        preview.allocationRows.find(r => r.assetReceiptId == f.widget.assetReceiptId).issuedAmount == 7.2
        preview.allocationRows.find(r => r.assetReceiptId == f.gadget.assetReceiptId).onHandAmount == 18
        denied.includes("PERMISSION_DENIED")
        one("mantle.ledger.transaction.AcctgTrans", {acctgTransId: posted.acctgTransId}).isPosted == "Y"
        lines.length == 4
        lines.find(r => r.debitCreditFlag == "C").glAccountId == "519100000"
        lines.find(r => r.debitCreditFlag == "C").amount == 36
        lines.filter(r => r.glAccountId == "141000000").reduce((n, r) => n.add(r.amount), toDecimal(0)) == 28.8
        lines.find(r => r.glAccountId == "512000000").amount == 7.2
        widget.acquireCost == 6.8
        gadget.acquireCost == 23.6
        again.acctgTransId == posted.acctgTransId && again.alreadyApplied == true
        twice.includes("ALREADY_ALLOCATED")
        allocations.length == 2
        allocations.every(r => r.statusId == "LcaPosted" && r.acctgTransId == posted.acctgTransId)
    }
})

feature("the valuation agrees with the inventory account after the landed cost", {
    when() {
        return {
            report: valuation(),
            foreign: asUser(f.users.read, () => rejected(REPORT + "run#InventoryValuation", {organizationPartyId: other.org}))
        }
    },
    then({report, foreign}) {
        report.summary.stockValue == 158.8
        report.summary.inventoryBalance == 158.8
        report.summary.agrees == true
        report.valuationRows.find(r => r.productId == "P13_WIDGET").value == 40.8
        report.valuationRows.find(r => r.productId == "P13_WIDGET").difference == 0
        foreign.includes("ORGANIZATION_DENIED")
    }
})

feature("a revaluation is refused with the flag off; on, it sets the forward cost and the valuation still agrees", {
    when() {
        call("create#mantle.product.cost.ProductStandardCost", {
            productStandardCostId: "P13_GADGET_STD",
            productId: "P13_GADGET",
            organizationPartyId: f.org,
            state: "approved",
            fromDate: "2000-01-01T00:00:00Z",
            quantity: 1,
            quantityUomId: "OTH_ea",
            priceUomId: "USD",
            unitCost: 25,
            totalCost: 25,
            complete: "Y"
        })
        const args = {productStandardCostId: "P13_GADGET_STD", organizationPartyId: f.org, changeReason: "Supplier price rise"}
        const off = asUser(f.users.gl, () => rejected(BOOK + "preview#Revaluation", args))
        call("update#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: f.org, inventoryRevaluationEnabled: "Y"})
        const reval = asUser(f.users.gl, () => {
            const p = call(BOOK + "preview#Revaluation", args)
            return call(BOOK + "post#Revaluation", {
                previewId: p.previewId,
                inputFingerprint: p.inputFingerprint,
                operationKey: "P13-REVAL-1"
            })
        })
        const issueId = issue(f.gadget.assetId, "P13_GADGET", 1)
        const issueTrans = one("mantle.ledger.transaction.AcctgTrans", {assetIssuanceId: issueId})
        return {
            off,
            reval,
            revalLines: entries(reval.acctgTransId),
            issueLines: entries(issueTrans.acctgTransId),
            report: valuation()
        }
    },
    then({off, reval, revalLines, issueLines, report}) {
        off.includes("disabled")
        revalLines.find(r => r.debitCreditFlag == "D").glAccountId == "141000000"
        revalLines.find(r => r.debitCreditFlag == "D").amount == 7
        revalLines.find(r => r.debitCreditFlag == "C").glAccountId == "525000000"
        issueLines.every(r => toDecimal(r.amount).compare(25) === 0)
        report.summary.stockValue == 140.8
        report.summary.agrees == true
    }
})

feature("a receipt without a cost basis and a ledger difference are listed in the valuation and the close checklist", {
    when() {
        f.nocost = receive("P13_NOCOST", 3, null)
        // a manual entry to the inventory account that no stock explains
        const manual = call("mantle.ledger.LedgerServices.create#AcctgTrans", {
            acctgTransTypeEnumId: "AttInternal",
            organizationPartyId: f.org,
            transactionDate: ec.user.nowTimestamp,
            amountUomId: "USD",
            description: "Unexplained inventory"
        }).acctgTransId
        call("mantle.ledger.LedgerServices.create#AcctgTransEntry", {
            acctgTransId: manual,
            glAccountId: "141000000",
            debitCreditFlag: "D",
            amount: 5
        })
        call("mantle.ledger.LedgerServices.create#AcctgTransEntry", {
            acctgTransId: manual,
            glAccountId: "525000000",
            debitCreditFlag: "C",
            amount: 5
        })
        call("mantle.ledger.LedgerServices.post#AcctgTrans", {acctgTransId: manual})
        const p = {organizationPartyId: f.org, timePeriodId: currentMonth(f.org)}
        const check = id => asUser(f.users.read, () => call(REPORT + "check#ValuationClose", Object.assign({checkEnumId: id}, p)))
        return {
            report: valuation(),
            costBasis: check("PccReceiptCostBasis"),
            tieOut: check("PccValuationTieOut"),
            checklist: asUser(f.users.read, () => call("mantle.ledger.CloseServices.get#Checklist", p))
        }
    },
    then({report, costBasis, tieOut, checklist}) {
        report.exceptionRows.some(r => r.movementId == f.nocost.assetReceiptId && r.resultEnumId == "AtrNoAcquireCost")
        report.summary.difference == -5
        report.valuationRows.find(r => r.productId == "").ledgerBalance == 5
        costBasis.count == 1 && costBasis.items[0].text.includes(f.nocost.assetReceiptId)
        tieOut.count == 1 && tieOut.items[0].text.includes("difference")
        checklist.checkRows.some(r => r.checkEnumId == "PccReceiptCostBasis" && r.count == 1)
        checklist.checkRows.some(r => r.checkEnumId == "PccValuationTieOut" && r.count == 1)
    }
})

feature("a count variance posts to the reason's account, then a scrap reason to the asset type's scrap account", {
    when() {
        call("create#mantle.ledger.config.VarianceReasonGlAccount", {
            organizationPartyId: f.org,
            varianceReasonEnumId: "InVrScrap",
            glAccountId: "519000000"
        })
        // the organization's inventory mapping (copied from DefaultSettings) gains a scrap account
        const mapping = list("mantle.ledger.config.AssetTypeGlAccount", {
            organizationPartyId: f.org,
            assetTypeEnumId: "AstTpInventory",
            classEnumId: null,
            assetId: null
        })[0]
        call("update#mantle.ledger.config.AssetTypeGlAccount", {
            assetTypeGlAccountId: mapping.assetTypeGlAccountId,
            scrapGlAccountId: "519200000"
        })
        const change = reason => {
            const out = call("mantle.product.AssetServices.record#PhysicalInventoryChange", {
                productId: "P13_WIDGET",
                facilityId: f.facilityId,
                ownerPartyId: f.org,
                quantityChange: -1,
                varianceReasonEnumId: reason
            })
            const trans = one("mantle.ledger.transaction.AcctgTrans", {physicalInventoryId: out.physicalInventoryId})
            return entries(trans.acctgTransId).find(r => r.debitCreditFlag == "D").glAccountId
        }
        return {scrap: change("InVrScrap"), expired: change("InVrExpired"), lost: change("InVrLost")}
    },
    then({scrap, expired, lost}) {
        scrap == "519000000"
        expired == "519200000"
        lost == "527000000"
    }
})

feature("stock transactions list the period's movements; another organization's period is refused", {
    when() {
        const p = {organizationPartyId: f.org, timePeriodId: currentMonth(f.org)}
        return {
            report: asUser(f.users.read, () => call(REPORT + "run#StockTransactions", p)),
            foreign: asUser(f.users.read, () =>
                rejected(REPORT + "run#StockTransactions", {organizationPartyId: f.org, timePeriodId: currentMonth(other.org)})
            )
        }
    },
    then({report, foreign}) {
        report.totalRows.find(r => r.kind == "receipt").count == 3
        report.totalRows.find(r => r.kind == "issue").count == 2
        report.movementRows.some(r => r.movementId == f.widgetIssue && toDecimal(r.quantity).compare(-4) === 0)
        foreign.includes("PERIOD_UNAVAILABLE") || foreign.includes("RECORD_UNAVAILABLE")
    }
})

feature("cost data repair is finance administration's, reposts the product's history and keeps an audit event", {
    when() {
        const p = {
            organizationPartyId: f.org,
            productId: "P13_NOCOST",
            acquireCost: 3,
            changeReason: "Supplier invoice cost",
            operationKey: "P13-REPAIR-1"
        }
        const denied = asUser(f.users.gl, () => rejected(BOOK + "repair#ProductAcquireCost", p))
        const repaired = asUser(f.users.financeadmin, () => call(BOOK + "repair#ProductAcquireCost", p))
        return {
            denied,
            repaired,
            asset: one("mantle.product.asset.Asset", {assetId: f.nocost.assetId}),
            receipt: one("mantle.product.receipt.AssetReceipt", {assetReceiptId: f.nocost.assetReceiptId}),
            events: list("mantle.product.asset.AssetBookEvent", {operationKey: "P13-REPAIR-1"})
        }
    },
    then({denied, repaired, asset, receipt, events}) {
        denied.includes("PERMISSION_DENIED")
        repaired.repairedCount == 1
        asset.acquireCost == 3
        receipt.acctgTransResultEnumId == "AtrSuccess"
        events.length == 1 && events[0].eventTypeEnumId == "AbeCostDataRepair" && events[0].changeReason != null
    }
})
