// The statement and analysis reports (AC-12, F6, F16): balance sheet, income statement, the period series, posted amounts,
// the partner ledger and sales analysis of an organization's own periods and records. An open month is summed from its
// posted entries and a closed one read from its stored summary rows; a reader of one organization is refused another's,
// and a period of another organization. Standalone: two spec-local organizations, each with its users.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingReceivablesFixtures.js")
const svc = (name, p) => helper().call(name, p)
const refused = (name, p) => helper().rejected(name, p)
const policy = () => helper().lib.policy
const ledger = name => "mantle.ledger.LedgerReportServices." + name
let f, g, month, otherMonth, lastMonth, invoiceId

// The organization's fiscal month holding the day, made when missing.
function monthOf(org, date) {
    return svc("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
        organizationPartyId: org,
        filterDate: date,
        timePeriodTypeId: "FiscalMonth"
    }).timePeriodList[0].timePeriodId
}
// A posted transaction of two lines, the debit with the party given.
function post(org, debitAccount, creditAccount, amount, otherPartyId) {
    const acctgTransId = svc("mantle.ledger.LedgerServices.create#AcctgTrans", {
        organizationPartyId: org,
        amountUomId: "USD",
        acctgTransTypeEnumId: "AttInternal",
        otherPartyId
    }).acctgTransId
    svc("mantle.ledger.LedgerServices.create#AcctgTransEntry", {
        acctgTransId,
        glAccountId: debitAccount,
        debitCreditFlag: "D",
        amount
    })
    svc("mantle.ledger.LedgerServices.create#AcctgTransEntry", {
        acctgTransId,
        glAccountId: creditAccount,
        debitCreditFlag: "C",
        amount
    })
    svc("mantle.ledger.LedgerServices.post#AcctgTrans", {acctgTransId})
    return acctgTransId
}
const num = (map, key) => (map?.[key] == null ? 0 : dec(map[key]).toNumber())

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("NATIVE_STMT")
        g = helper().fixtures("NATIVE_STMT_OTHER")
        post(f.org, "111100000", "331100000", "1000")
        post(f.org, "121000000", "411000000", "300", f.customer)
        post(g.org, "121000000", "411000000", "999", g.customer)
        // posting made the months; an old month of no postings stands for a closed one
        month = monthOf(f.org, ec.user.nowTimestamp)
        otherMonth = monthOf(g.org, ec.user.nowTimestamp)
        lastMonth = svc("mantle.party.TimeServices.getOrCreate#TimePeriod", {
            partyId: f.org,
            timePeriodTypeId: "FiscalMonth",
            fromDate: "2001-01-01",
            thruDate: "2001-01-31",
            periodName: "January 2001"
        }).timePeriodId
        login(f.users.ar)
        const invoice = helper().draft(f, "150")
        svc("mantle.account.InvoiceServices.change#InvoiceState", {
            invoiceId: invoice.invoiceId,
            action: "finalize",
            lastUpdatedStamp: invoice.lastUpdatedStamp
        })
        invoiceId = invoice.invoiceId
        login("john.doe")
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    }
})

feature("an open month's statements are summed from its posted entries", {
    when() {
        login(f.users.read)
        const p = {organizationPartyId: f.org, timePeriodIdList: [month]}
        return {
            balance: svc(ledger("run#BalanceSheet"), p),
            income: svc(ledger("run#IncomeStatement"), p),
            cash: svc(ledger("run#CashFlowStatement"), p),
            retained: svc(ledger("run#RetainedEarningsStatement"), p),
            ratios: svc(ledger("run#FinancialRatios"), p)
        }
    },
    then({balance, income, cash, retained, ratios}) {
        balance.complete == true
        balance.asOf != null
        balance.summaryRows.every(row => row.closedSummary == false)
        num(balance.netAssetTotalMap.totalBalance, month) == 1450
        num(balance.netAssetTotalMap.totalBalance, month) ==
            num(balance.liabilityEquityTotalMap.totalBalance, month) + num(balance.netIncomeOut.totalBalance, month)
        num(income.netIncomeMap, month) == 450
        num(income.classInfoById.REVENUE.totalPostedByTimePeriod, month) == 450
        num(cash.netIncomeMap, month) == 450
        num(retained.netIncomeMap, month) == 450
        num(ratios.salesMap, month) == 450
    }
})

feature("a closed month is read from its stored summary rows", {
    when() {
        svc("create#mantle.ledger.account.GlAccountOrgTimePeriod", {
            glAccountId: "111100000",
            organizationPartyId: f.org,
            timePeriodId: lastMonth,
            beginningBalance: 0,
            postedDebits: 777,
            postedCredits: 0,
            postedDebitsNoClosing: 777,
            postedCreditsNoClosing: 0,
            endingBalance: 777
        })
        svc("update#mantle.party.time.TimePeriod", {timePeriodId: lastMonth, isClosed: "Y"})
        login(f.users.read)
        const report = svc(ledger("run#BalanceSheet"), {organizationPartyId: f.org, timePeriodIdList: [lastMonth]})
        login("john.doe")
        svc("update#mantle.party.time.TimePeriod", {timePeriodId: lastMonth, isClosed: "N"})
        return {report}
    },
    then({report}) {
        report.summaryRows.length == 1
        report.summaryRows[0].closedSummary == true
        num(report.netAssetTotalMap.totalBalance, lastMonth) == 777
    }
})

feature("the period series, posted amounts and partner ledger read the organization's own postings", {
    when() {
        login(f.users.read)
        const series = svc(ledger("get#PeriodSeriesSummary"), {
            organizationPartyId: f.org,
            timePeriodGroups: [[month]],
            datasets: [{datasetId: "revenue", classes: ["REVENUE"], negateDebit: true}]
        })
        const posted = svc(ledger("run#PostedAmountSummary"), {organizationPartyId: f.org, timePeriodId: month})
        const partners = svc(ledger("run#PartnerLedger"), {organizationPartyId: f.org, timePeriodId: month})
        return {series, posted, partners}
    },
    then({series, posted, partners}) {
        dec(series.datasetsById.revenue.data[0]).toNumber() == 450
        series.complete == true
        dec(posted.resultList.find(row => row.glAccountId == "121000000").debitAmount).toNumber() == 450
        dec(posted.resultList.find(row => row.glAccountId == "111100000").endingBalance).toNumber() == 1000
        partners.complete == true
        partners.partyRows.length == 1
        partners.partyRows[0].partyId == f.customer
        dec(partners.partyRows[0].closing).toNumber() == 450
        partners.reportRows.filter(row => row.rowType == "entry").length == 2
        partners.reportRows.some(row => row.sourceKind == "invoices" && row.sourceId == invoiceId)
    }
})

feature("sales analysis groups the organization's own invoices", {
    when() {
        login(f.users.read)
        const byCustomer = svc("mantle.sales.SalesReportServices.run#SalesAnalysis", {
            organizationPartyId: f.org,
            timePeriodId: month,
            groupBy: "customer"
        })
        const byClass = svc("mantle.sales.SalesReportServices.run#SalesAnalysis", {
            organizationPartyId: f.org,
            timePeriodId: month,
            groupBy: "customerClass"
        })
        return {byCustomer, byClass}
    },
    then({byCustomer, byClass}) {
        byCustomer.complete == true
        byCustomer.analysisRows.length == 1
        byCustomer.analysisRows[0].customerPartyId == f.customer
        byCustomer.analysisRows[0].invoicedValue.eq(150)
        byClass.analysisRows.length == 1
        byClass.analysisRows[0].label == "Unclassified"
    }
})

feature("a reader of one organization is refused another's, its periods, and a user without report read", {
    when() {
        login(f.users.read)
        const reasons = {
            otherOrganization: refused(ledger("run#BalanceSheet"), {organizationPartyId: g.org, timePeriodIdList: [otherMonth]}),
            otherPeriod: refused(ledger("run#IncomeStatement"), {organizationPartyId: f.org, timePeriodIdList: [otherMonth]}),
            classInfo: refused(ledger("get#GlAccountClassReportInfo"), {
                organizationPartyId: f.org,
                timePeriodIdList: [otherMonth],
                glAccountClassEnumId: "REVENUE"
            }),
            series: refused(ledger("get#PeriodSeriesSummary"), {
                organizationPartyId: f.org,
                timePeriodGroups: [[otherMonth]],
                datasets: [{classes: ["REVENUE"]}]
            }),
            posted: refused(ledger("run#PostedAmountSummary"), {organizationPartyId: g.org}),
            partners: refused(ledger("run#PartnerLedger"), {organizationPartyId: f.org, timePeriodId: otherMonth}),
            ledgerInfo: refused(ledger("get#AccountLedgerInfo"), {glAccountIdList: ["111100000"], timePeriodId: otherMonth}),
            sales: refused("mantle.sales.SalesReportServices.run#SalesAnalysis", {organizationPartyId: g.org})
        }
        login(f.users.ap)
        reasons.noReportRead = refused(ledger("run#IncomeStatement"), {organizationPartyId: f.org, timePeriodIdList: [month]})
        return reasons
    },
    then(reasons) {
        reasons.otherOrganization.includes("ORGANIZATION_DENIED")
        reasons.otherPeriod.includes("PERIOD_UNAVAILABLE")
        reasons.classInfo.includes("PERIOD_UNAVAILABLE")
        reasons.series.includes("PERIOD_UNAVAILABLE")
        reasons.posted.includes("ORGANIZATION_DENIED")
        /PERIOD_UNAVAILABLE|RECORD_UNAVAILABLE/.test(reasons.partners)
        reasons.ledgerInfo.includes("ORGANIZATION_DENIED")
        reasons.sales.includes("ORGANIZATION_DENIED")
        reasons.noReportRead.includes("PERMISSION_DENIED")
    }
})
