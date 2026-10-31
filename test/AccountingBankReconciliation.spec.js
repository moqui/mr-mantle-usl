// Bank statements and their reconciliation (ReconciliationServices) and deposit slips (PaymentServices): statement
// imports keyed by line identity, match rules that apply only exact matches, statement sessions that finish at zero
// difference, and a deposit's one bank line. Spec-local organization, bank account and users.
const settlementFixtures = () => ec.resource.script("component://mr-mantle/test/AccountingSettlementFixtures.js")
const rec = "mantle.account.ReconciliationServices."
let f
function native(name, parameters) {
    return call((name.includes(".") ? "" : rec) + name, parameters)
}
function rejected(name, parameters) {
    return settlementFixtures().rejected((name.includes(".") ? "" : rec) + name, parameters)
}
function lines(bankId) {
    return ec.entity.find("mantle.account.method.PaymentMethodTrans").condition("paymentMethodId", bankId).disableAuthz().count()
}
function line(bankId, fitId) {
    return ec.entity
        .find("mantle.account.method.PaymentMethodTrans")
        .condition({paymentMethodId: bankId, fitId})
        .disableAuthz()
        .one()
}
function payment(paymentId) {
    return ec.entity.find("mantle.account.payment.Payment").condition("paymentId", paymentId).disableAuthz().one()
}
// A receipt from the customer into the bank account, delivered.
function receipt(amount, extra = {}) {
    return settlementFixtures().payment(f, amount, "receivable", Object.assign({toPaymentMethodId: f.bankId}, extra))
}
// A bank line typed by hand, posted today.
function bankLine(fitId, amount, extra = {}) {
    native(
        "create#PaymentMethodTrans",
        Object.assign(
            {paymentMethodId: f.bankId, fitId, postedDate: f.timestamp, transAmount: amount, transType: "PMTT_CREDIT"},
            extra
        )
    )
    return fitId
}
function csv(rows) {
    return ["Date,Description,Amount,Reference"].concat(rows).join("\n")
}
const bai = (reference, amount = "5000") =>
    [
        "01,SENDER,RECEIVER,261020,1200,1,80,,2/",
        "02,111000025,ORIG,1,261020,2359,USD,2/",
        "03,123456789,USD,015,100000,,,045,100000,,/",
        `16,108,${amount},S,2500,2500,Deposit memo,${reference}`,
        "16,475,2000,0,CHK9,1001,Check memo",
        `49,${100000 + 100000 + Number(amount) + 2000},5/`,
        "98,0,1,7/",
        "99,0,1,9/"
    ].join("\n")

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const h = settlementFixtures()
        f = h.fixtures("ACCT_P9_BANK")
        f.bankId = "ACCT_P9_BANK_OPERATING"
        call("create#mantle.account.method.PaymentMethod", {
            paymentMethodId: f.bankId,
            ownerPartyId: f.org,
            paymentMethodTypeEnumId: "PmtBankAccount",
            currencyUomId: "USD",
            fromDate: 0,
            description: "Operating bank",
            glAccountId: "111100000"
        })
        call("create#mantle.account.method.BankAccount", {
            paymentMethodId: f.bankId,
            bankName: "Fixture bank",
            typeEnumId: "BatChecking",
            accountNumber: "123456789",
            routingNumber: "111000025"
        })
        f.users.banker = h.user(f, "BANKER", ["BANK_RECONCILE", "PAYMENT_VIEW", "PAYMENT_EDIT"])
        f.users.reader = h.user(f, "BANK_READER", ["ACCOUNTING_VIEW"])
        f.users.payer = h.user(f, "PAYER", ["PAYMENT_VIEW", "PAYMENT_EDIT"])
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    }
})

feature("a statement with a duplicate and a malformed row imports the rest and lists both", {
    when() {
        const first = native("review#StatementImport", {
            paymentMethodId: f.bankId,
            formatEnumId: "SifCsv",
            statementText: csv([`${f.day},Coffee supplies,-12.50,R1`, `${f.day},Customer receipt,"1,200.00",R2`])
        })
        native("commit#StatementImport", {statementImportId: first.statementImportId})
        const before = lines(f.bankId)
        const second = native("review#StatementImport", {
            paymentMethodId: f.bankId,
            formatEnumId: "SifCsv",
            fileName: "october.csv",
            statementText: csv([
                `${f.day},Customer receipt,"1,200.00",R2`,
                `not a day,Broken row,10.00,R3`,
                `${f.day},Bank fee,(4.00),R4`
            ])
        })
        const committed = native("commit#StatementImport", {statementImportId: second.statementImportId})
        const again = native("commit#StatementImport", {statementImportId: second.statementImportId})
        const review = native("get#StatementImport", {statementImportId: second.statementImportId})
        const preview = native("preview#CsvStatement", {
            paymentMethodId: f.bankId,
            statementText: "When;What;Value\n" + f.day + ";Fee;-1.00",
            delimiter: ";",
            dateColumn: "When",
            amountColumn: "Value",
            descriptionColumn: "What"
        })
        return {first, before, second, committed, again, review, preview, after: lines(f.bankId)}
    },
    then({first, before, second, committed, again, review, preview, after}) {
        first.newCount == 2
        second.newCount == 1 && second.duplicateCount == 1 && second.rejectedCount == 1
        committed.committedCount == 1 && committed.duplicateCount == 1 && committed.rejectedCount == 1
        after == before + 1
        again.alreadyCommitted == true && again.committedCount == 1
        review.statementImport.statusId == "SimCommitted" && review.statementImport.fileName == "october.csv"
        review.importRows.map(row => row.status).join() == "duplicate,rejected,imported"
        review.importRows[1].error.includes("not a date")
        review.importRows[2].transAmount == "-4.00"
        preview.columns.join() == "When,What,Value" && preview.previewRows[0].transAmount == "-1.00"
    }
})
feature("the same BAI2 file imported twice adds nothing the second time, through review and through import#BaiVersion2", {
    when() {
        const text = bai("BAI-REF-1")
        const review = native("review#StatementImport", {paymentMethodId: f.bankId, formatEnumId: "SifBai2", statementText: text})
        native("commit#StatementImport", {statementImportId: review.statementImportId})
        const before = lines(f.bankId)
        const again = native("review#StatementImport", {paymentMethodId: f.bankId, formatEnumId: "SifBai2", statementText: text})
        native("commit#StatementImport", {statementImportId: again.statementImportId})
        call("mantle.account.BaiServices.import#BaiVersion2", {paymentMethodId: f.bankId, baiString: text})
        const other = rejected("review#StatementImport", {
            paymentMethodId: f.bankId,
            formatEnumId: "SifBai2",
            statementText: text.replace("02,111000025", "02,999999999")
        })
        return {review, again, before, after: lines(f.bankId), other}
    },
    then({review, again, before, after, other}) {
        review.newCount == 2
        again.newCount == 0 && again.duplicateCount == 2
        after == before
        other.includes("STATEMENT_FILE_INVALID")
    }
})
feature("an OFX line is identified by its FIT id", {
    when() {
        const ofx = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD
<BANKACCTFROM><BANKID>111000025<ACCTID>123456789<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261020120000<TRNAMT>-25.00<FITID>OFX-P9-1<NAME>Supplier</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261020120000<TRNAMT>-25.00<FITID>OFX-P9-1<NAME>Supplier again</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261020<TRNAMT>abc<FITID>OFX-P9-2</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`
        const review = native("review#StatementImport", {paymentMethodId: f.bankId, formatEnumId: "SifOfx", statementText: ofx})
        const result = native("commit#StatementImport", {statementImportId: review.statementImportId})
        return {review, result, created: line(f.bankId, "OFX-P9-1")}
    },
    then({review, result, created}) {
        review.newCount == 1 && review.duplicateCount == 1 && review.rejectedCount == 1
        result.committedCount == 1
        created.transName == "Supplier"
    }
})
feature("a rule applies only an exact unambiguous match; an ambiguous rule suggests and does not apply", {
    when() {
        const exactPayment = receipt("310", {paymentRefNum: "INV-310"}),
            twinA = receipt("320"),
            twinB = receipt("320")
        const exactLine = bankLine("RULE-EXACT", "310", {transName: "ACME PAYMENT 310"}),
            twinLine = bankLine("RULE-TWIN", "320", {transName: "ACME PAYMENT 320"})
        const rule = native("store#Rule", {
            organizationPartyId: f.org,
            description: "Acme receipts",
            matchText: "acme payment",
            directionEnumId: "BmdIncoming",
            partyId: f.customer,
            autoApply: "Y"
        })
        const test = native("test#Rule", {organizationPartyId: f.org, bankMatchRuleId: rule.bankMatchRuleId})
        const noParty = rejected("store#Rule", {organizationPartyId: f.org, matchText: "x", autoApply: "Y"})
        const applied = native("apply#Rules", {organizationPartyId: f.org, paymentMethodId: f.bankId})
        const lineRows = native("find#BankLines", {
            paymentMethodId: f.bankId,
            lineState: "open",
            withSuggestions: true,
            pageSize: 100
        }).lineRows
        native("store#Rule", {organizationPartyId: f.org, bankMatchRuleId: rule.bankMatchRuleId, ended: "Y"})
        return {
            exactPayment,
            twins: [twinA, twinB],
            test,
            noParty,
            applied,
            exact: line(f.bankId, exactLine),
            twin: line(f.bankId, twinLine),
            twinRow: lineRows.find(row => row.fitId === twinLine),
            ended: native("test#Rule", {organizationPartyId: f.org, matchText: "acme payment"})
        }
    },
    then({exactPayment, twins, test, noParty, applied, exact, twin, twinRow, ended}) {
        test.resultRows.find(row => row.fitId === "RULE-EXACT").wouldApply == true
        test.resultRows.find(row => row.fitId === "RULE-TWIN").ambiguous == true
        test.resultRows.find(row => row.fitId === "RULE-TWIN").candidateCount == 2
        noParty.includes("RULE_PARTY_REQUIRED")
        applied.appliedCount == 1
        exact.paymentId == exactPayment
        payment(exactPayment).reconcileStatusId == "PmtrRec"
        twin.paymentId == null
        twins.every(id => payment(id).reconcileStatusId != "PmtrRec")
        twinRow.ambiguous == true && twinRow.suggestionText == "2 possible matches"
        ended.resultRows.every(row => row.wouldApply == false)
    }
})
feature("two sessions cannot clear one line", {
    when() {
        // January and February 2026, months no other feature posts lines in
        const first = native("create#Reconciliation", {
            paymentMethodId: f.bankId,
            statementReference: "Concurrent",
            statementFromDate: "2026-01-01",
            statementThruDate: "2026-01-31",
            openingBalance: 0,
            closingBalance: 0
        })
        const args = {paymentMethodId: f.bankId}
        const concurrent = parallel(
            2,
            (thread, args) => {
                login("john.doe")
                ec.artifactExecution.disableAuthz()
                try {
                    return call("mantle.account.ReconciliationServices.create#Reconciliation", {
                        paymentMethodId: args.paymentMethodId,
                        statementFromDate: "2026-02-01",
                        statementThruDate: "2026-02-28",
                        openingBalance: 0,
                        closingBalance: 0
                    })
                } catch (error) {
                    ec.message.clearErrors()
                    return {error: error.message}
                }
            },
            args,
            {transaction: false, timeout: 30}
        )
        const overlap = rejected("create#Reconciliation", {
            paymentMethodId: f.bankId,
            statementFromDate: "2026-01-15",
            statementThruDate: "2026-02-10",
            openingBalance: 0,
            closingBalance: 0
        })
        // a line cleared in January moved into February is still January's
        const fitId = bankLine("SESSION-LINE", "-9.00", {postedDate: new Date(2026, 0, 20, 12).getTime(), transType: "PMTT_FEE"})
        native("noReconcile#PaymentMethodTrans", {paymentMethodId: f.bankId, fitId, noReconcileReason: "Bank fee booked monthly"})
        native("store#Reconciliation", {bankReconciliationId: first.bankReconciliationId, clearFitIdList: [fitId]})
        native("update#PaymentMethodTrans", {paymentMethodId: f.bankId, fitId, postedDate: new Date(2026, 1, 20, 12).getTime()})
        const february = concurrent.find(row => row.bankReconciliationId)
        const second = rejected("store#Reconciliation", {
            bankReconciliationId: february.bankReconciliationId,
            clearFitIdList: [fitId]
        })
        return {concurrent, overlap, second}
    },
    then({concurrent, overlap, second}) {
        concurrent.filter(row => row.bankReconciliationId).length == 1
        concurrent.filter(row => row.error).length == 1
        concurrent.find(row => row.error).error.includes("RECONCILIATION_OVERLAP")
        overlap.includes("RECONCILIATION_OVERLAP")
        second.includes("BANK_LINE_CLEARED")
    }
})
feature("a statement with a difference cannot be finished; at zero difference it finishes and its lines stay reconciled", {
    when() {
        const paid = receipt("75", {effectiveDate: new Date(2026, 2, 9, 12).getTime()})
        const day = n => new Date(2026, 2, n, 12).getTime()
        const income = bankLine("MAR-IN", "75", {postedDate: day(10)}),
            fee = bankLine("MAR-FEE", "-5", {postedDate: day(11), transType: "PMTT_FEE"}),
            open = bankLine("MAR-OPEN", "20", {postedDate: day(12)})
        const session = native("create#Reconciliation", {
            paymentMethodId: f.bankId,
            statementReference: "March",
            statementFromDate: "2026-03-01",
            statementThruDate: "2026-03-31",
            openingBalance: 100,
            closingBalance: 200
        })
        const id = session.bankReconciliationId
        native("reconcile#BankLine", {paymentMethodId: f.bankId, fitId: income, candidate: "payment:" + paid})
        const noReason = rejected("store#Reconciliation", {bankReconciliationId: id, clearFitIdList: [fee]})
        native("noReconcile#PaymentMethodTrans", {paymentMethodId: f.bankId, fitId: fee, noReconcileReason: "Monthly fee"})
        const unmatched = rejected("store#Reconciliation", {bankReconciliationId: id, clearFitIdList: [open]})
        native("store#Reconciliation", {bankReconciliationId: id, clearFitIdList: [income, fee]})
        const uncleared = rejected("finish#Reconciliation", {bankReconciliationId: id})
        native("noReconcile#PaymentMethodTrans", {paymentMethodId: f.bankId, fitId: open, noReconcileReason: "Returned item"})
        native("store#Reconciliation", {bankReconciliationId: id, clearFitIdList: [open]})
        const difference = rejected("finish#Reconciliation", {bankReconciliationId: id})
        const figures = native("get#Reconciliation", {bankReconciliationId: id}).figures
        native("store#Reconciliation", {bankReconciliationId: id, closingBalance: 190})
        native("finish#Reconciliation", {bankReconciliationId: id})
        const finished = native("get#Reconciliation", {bankReconciliationId: id})
        const reopenLine = rejected("unreconcile#PaymentMethodTrans", {paymentMethodId: f.bankId, fitId: income})
        const nextOpening = rejected("create#Reconciliation", {
            paymentMethodId: f.bankId,
            statementFromDate: "2026-04-01",
            statementThruDate: "2026-04-30",
            openingBalance: 150,
            closingBalance: 190
        })
        const next = native("create#Reconciliation", {
            paymentMethodId: f.bankId,
            statementFromDate: "2026-04-01",
            statementThruDate: "2026-04-30",
            closingBalance: 190
        })
        const nextRow = ec.entity
            .find("mantle.account.method.BankReconciliation")
            .condition("bankReconciliationId", next.bankReconciliationId)
            .disableAuthz()
            .one()
        return {noReason, unmatched, uncleared, difference, figures, finished, reopenLine, nextOpening, nextRow, paid}
    },
    then({noReason, unmatched, uncleared, difference, figures, finished, reopenLine, nextOpening, nextRow, paid}) {
        noReason.includes("BANK_LINE_UNMATCHED")
        unmatched.includes("BANK_LINE_UNMATCHED")
        uncleared.includes("BANK_LINES_UNCLEARED")
        difference.includes("STATEMENT_DIFFERENCE")
        toDecimal(figures.difference).eq(10) && toDecimal(figures.computedClosing).eq(190)
        finished.reconciliation.statusId == "BrecFinished"
        finished.reconciliation.clearedCount == 3
        toDecimal(finished.reconciliation.clearedInflow).eq(95) && toDecimal(finished.reconciliation.clearedOutflow).eq(5)
        payment(paid).reconcileStatusId == "PmtrRec"
        reopenLine.includes("BANK_LINE_FINISHED")
        nextOpening.includes("OPENING_BALANCE_MISMATCH")
        toDecimal(nextRow.openingBalance).eq(190)
    }
})
feature("a deposit's one bank line reconciles its receipts once", {
    when() {
        const a = receipt("40"),
            b = receipt("60"),
            elsewhere = settlementFixtures().payment(f, "15", "receivable")
        const offered = native("mantle.account.PaymentServices.find#DepositReceipts", {paymentMethodId: f.bankId, pageSize: 100})
        const slip = native("mantle.account.PaymentServices.create#DepositSlip", {
            paymentMethodId: f.bankId,
            paymentIdList: [a, b],
            referenceNumber: "Slip 7",
            operationKey: "p9-deposit-7"
        })
        const retry = native("mantle.account.PaymentServices.create#DepositSlip", {
            paymentMethodId: f.bankId,
            paymentIdList: [b, a],
            referenceNumber: "Slip 7",
            operationKey: "p9-deposit-7"
        })
        const twice = rejected("mantle.account.PaymentServices.create#DepositSlip", {
            paymentMethodId: f.bankId,
            paymentIdList: [a],
            operationKey: "p9-deposit-8"
        })
        const outside = rejected("mantle.account.PaymentServices.create#DepositSlip", {
            paymentMethodId: f.bankId,
            paymentIdList: [elsewhere],
            operationKey: "p9-deposit-9"
        })
        const one = bankLine("DEPOSIT-1", "100"),
            other = bankLine("DEPOSIT-2", "100")
        const candidates = native("find#BankLineCandidates", {paymentMethodId: f.bankId, fitId: one}).candidateRows
        native("reconcile#BankLine", {paymentMethodId: f.bankId, fitId: one, candidate: "deposit:" + slip.paymentDepositId})
        const second = rejected("reconcile#BankLine", {
            paymentMethodId: f.bankId,
            fitId: other,
            candidate: "deposit:" + slip.paymentDepositId
        })
        const reconciled = [a, b].map(id => payment(id).reconcileStatusId)
        native("unreconcile#PaymentMethodTrans", {paymentMethodId: f.bankId, fitId: one})
        return {
            offered,
            slip,
            retry,
            twice,
            outside,
            candidates,
            second,
            reconciled,
            undone: [a, b].map(id => payment(id).reconcileStatusId),
            receipts: [a, b, elsewhere]
        }
    },
    then({offered, slip, retry, twice, outside, candidates, second, reconciled, undone, receipts}) {
        offered.receiptRows.some(row => row.paymentId === receipts[0])
        offered.receiptRows.every(row => row.paymentId !== receipts[2])
        toDecimal(slip.totalAmount).eq(100) && slip.paymentCount == 2
        retry.alreadyCreated == true && retry.paymentDepositId == slip.paymentDepositId
        payment(receipts[0]).paymentDepositId == slip.paymentDepositId
        twice.includes("RECEIPT_DEPOSITED")
        outside.includes("RECEIPT_INVALID")
        candidates.some(row => row.value === "deposit:" + slip.paymentDepositId)
        candidates.every(row => !row.value.startsWith("payment:" + receipts[0]))
        second.includes("DEPOSIT_RECONCILED")
        reconciled.join() == "PmtrRec,PmtrRec"
        undone.join() == "PmtrNot,PmtrNot"
    }
})
feature(
    "bank reconciliation needs BANK_RECONCILE and a deposit needs payment edit; the same requests pass for those who hold them",
    {
        when() {
            const request = {
                paymentMethodId: f.bankId,
                formatEnumId: "SifCsv",
                statementText: csv([`${f.day},Access fee,-1.00,A1`])
            }
            const as = (user, action) => {
                login(user)
                // artifact authorization off: the services' own permission checks decide
                ec.artifactExecution.disableAuthz()
                try {
                    return action()
                } finally {
                    login("john.doe")
                    ec.artifactExecution.disableAuthz()
                }
            }
            const deposit = id => ({paymentMethodId: f.bankId, paymentIdList: [id], operationKey: "p9-access-" + id})
            const first = receipt("11"),
                second = receipt("12")
            return {
                reader: as(f.users.reader, () => rejected("review#StatementImport", request)),
                readerLines: as(f.users.reader, () => native("find#BankLines", {paymentMethodId: f.bankId}).recordCount),
                banker: as(f.users.banker, () => native("review#StatementImport", request).newCount),
                payer: as(f.users.payer, () => rejected("review#StatementImport", request)),
                readerDeposit: as(f.users.reader, () =>
                    rejected("mantle.account.PaymentServices.create#DepositSlip", deposit(first))
                ),
                payerDeposit: as(
                    f.users.payer,
                    () => native("mantle.account.PaymentServices.create#DepositSlip", deposit(second)).paymentCount
                )
            }
        },
        then({reader, readerLines, banker, payer, readerDeposit, payerDeposit}) {
            reader.includes("PERMISSION_DENIED")
            readerLines > 0
            banker == 1
            payer.includes("PERMISSION_DENIED")
            readerDeposit.includes("PERMISSION_DENIED")
            payerDeposit == 1
        }
    }
)
feature("a financial account's movements need payment edit authority in its organization", {
    when() {
        const finAccountId = call("mantle.account.FinancialAccountServices.create#FinancialAccount", {
            finAccountTypeId: "CustomerCredit",
            finAccountName: "Store credit",
            organizationPartyId: f.org,
            ownerPartyId: f.customer
        }).finAccountId
        const check = "mantle.account.FinancialAccountServices.check#FinancialAccountAccess"
        const as = (user, action) => {
            login(user)
            ec.artifactExecution.disableAuthz()
            try {
                return action()
            } finally {
                login("john.doe")
                ec.artifactExecution.disableAuthz()
            }
        }
        return {
            payer: as(f.users.payer, () => call(check, {finAccountId, need: "edit"}).canEdit),
            reader: as(f.users.reader, () => call(check, {finAccountId}).organizationPartyId),
            readerEdit: as(f.users.reader, () => rejected(check, {finAccountId, need: "edit"})),
            otherOrganization: rejected(check, {finAccountId, organizationPartyId: "ORG_ZIZI_RETAIL"})
        }
    },
    then({payer, reader, readerEdit, otherOrganization}) {
        payer == true
        reader == f.org
        readerEdit.includes("PERMISSION_DENIED")
        otherOrganization.includes("FINANCIAL_ACCOUNT_UNAVAILABLE")
    }
})
