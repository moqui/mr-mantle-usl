// Project cost posting (OtherAutoPostServices.post#WorkEffortCost, impl-accounting §4 and F45): a project's approved time
// at the entry's cost rate, debiting project cost (GatProjectLaborCost) and crediting labor clearing (GatLaborClearing),
// with the project on the transaction, for organizations with projectCostPostingEnabled. Each time entry's postings are
// kept on its PostingOperation ("wec:" and its id): what should be posted (its cost while its timesheet is approved,
// else nothing) less what was posted is posted as a dated delta, so undoing an approval or changing an entry reverses
// it on the day of the change. Production time is not project time: Manufacturing's labor events post it (D12). Time
// of an outside vendor is left to the vendor's bill.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const {find, one, rows, call} = lib
const OP = "mantle.ledger.transaction.PostingOperation"
const ENTRY = "mantle.work.time.TimeEntry"
const operationKey = timeEntryId => "wec:" + timeEntryId

// The project a work effort belongs to: itself, its root or the nearest project above it; null for other work.
function projectOf(workEffortId) {
    let effort = workEffortId ? one("mantle.work.effort.WorkEffort", {workEffortId}) : null
    if (effort?.rootWorkEffortId && effort.workEffortTypeEnumId !== "WetProject") {
        const root = one("mantle.work.effort.WorkEffort", {workEffortId: effort.rootWorkEffortId})
        if (root?.workEffortTypeEnumId === "WetProject") return root
    }
    for (let depth = 0; effort && depth < 12; depth++) {
        if (effort.workEffortTypeEnumId === "WetProject") return effort
        effort = effort.parentWorkEffortId
            ? one("mantle.work.effort.WorkEffort", {workEffortId: effort.parentWorkEffortId})
            : null
    }
    return null
}
const enabled = org => !!org && lib.preference(org).projectCostPostingEnabled === "Y"

// What a time entry's operation record says was posted: the lines of posted transactions, and whether one is still
// waiting unposted (in the error journal), when no further delta is posted until it is.
function postedOf(timeEntryId, lock = false, organizationPartyId = null) {
    const key = operationKey(timeEntryId)
    // the first posting of an entry makes its record before locking it, so two requests cannot both post it first
    if (lock && !one(OP, {operationKey: key}))
        call("create#" + OP, {
            operationKey: key,
            operationType: "WorkEffortCost",
            organizationPartyId,
            userId: ec.user.userId,
            submittedDate: ec.user.nowTimestamp,
            requestHash: lib.hash({timeEntryId}),
            status: "complete",
            resultEntityName: ENTRY,
            resultId: timeEntryId,
            resultJson: JSON.stringify({organizationPartyId, lines: []})
        })
    const query = find(OP, {operationKey: key})
    const row = (lock ? query.forUpdate(true) : query).one()
    const record = lib.lib.json(row?.resultJson, {lines: []})
    let amount = toDecimal(0)
    let waiting = null
    for (const line of record.lines || []) {
        const tx = one("mantle.ledger.transaction.AcctgTrans", {acctgTransId: line.acctgTransId})
        if (!tx) continue
        if (tx.isPosted === "Y") amount = amount.add(toDecimal(line.amount))
        else waiting = tx
    }
    return {row, record, amount, waiting}
}

// The cost rate of an entry: its own vendor rate, its vendor RateAmount, else the rate Mantle finds for it, read only.
function costRate(entry, currency) {
    if (entry.vendorHourRate != null) return {rate: toDecimal(entry.vendorHourRate), currency}
    let rateRow = entry.vendorRateAmountId
        ? one("mantle.humanres.rate.RateAmount", {rateAmountId: entry.vendorRateAmountId})
        : null
    if (!rateRow) {
        const found = call("mantle.work.TimeServices.find#TimeEntryRateAmount", {
            timeEntry: entry,
            ratePurposeEnumId: "RaprVendor",
            rateTypeEnumId: entry.rateTypeEnumId || "RatpStandard",
            rateCurrencyUomId: currency
        })
        rateRow = found.rateAmountId ? one("mantle.humanres.rate.RateAmount", {rateAmountId: found.rateAmountId}) : null
    }
    return rateRow ? {rate: toDecimal(rateRow.rateAmount ?? 0), currency: rateRow.rateCurrencyUomId || currency} : null
}

// One entry's cost basis now: its project and organization, the amount that should be posted and the delta to post, or
// why it cannot be computed (failureCode, failureMessage).
function basis(entry, lock = false, removed = false) {
    const known = postedOf(entry.timeEntryId)
    const project = projectOf(entry.workEffortId)
    const org = project?.ownerPartyId || known.record.organizationPartyId || known.row?.organizationPartyId || null
    const out = {
        timeEntryId: entry.timeEntryId,
        timesheetId: entry.timesheetId,
        workEffortId: project?.workEffortId || known.record.workEffortId || null,
        organizationPartyId: org,
        posted: known,
        target: toDecimal(0),
        delta: toDecimal(0)
    }
    if (!enabled(org)) return Object.assign(out, {skipped: true})
    const currency = lib.preference(org).baseCurrencyUomId
    out.currencyUomId = currency
    const sheet = entry.timesheetId ? one("mantle.work.time.Timesheet", {timesheetId: entry.timesheetId}) : null
    const internal = !entry.vendorPartyId || lib.organizationChain(org).includes(entry.vendorPartyId)
    if (!removed && project && internal && sheet?.statusId === "TmshApproved") {
        const rate = costRate(entry, currency)
        if (!rate) return Object.assign(out, {failureCode: "COST_RATE_MISSING", failureMessage: "No cost rate for this time"})
        if (rate.currency !== currency)
            return Object.assign(out, {failureCode: "CURRENCY_MISMATCH", failureMessage: "The cost rate is in " + rate.currency})
        out.target = ec.l10n.roundCurrency(toDecimal(entry.hours ?? 0).multiply(rate.rate), currency)
    }
    // nothing to post and nothing posted: no record is made
    if (out.target.isZero() && !known.row) return out
    const posted = lock ? postedOf(entry.timeEntryId, true, org) : known
    out.posted = posted
    if (posted.waiting) {
        const where = posted.waiting.glJournalId && posted.waiting.glJournalId === lib.preference(org).errorGlJournalId
        return Object.assign(out, {
            failureCode: "POSTING_WAITING",
            failureMessage:
                "Transaction " +
                posted.waiting.acctgTransId +
                (where ? " is in the error journal" : " is not posted") +
                "; post it first"
        })
    }
    out.delta = out.target.subtract(posted.amount)
    return out
}
function accounts(org) {
    const account = type =>
        call("mantle.ledger.LedgerServices.get#DefaultGlAccountByType", {organizationPartyId: org, glAccountTypeEnumId: type})
    return {cost: account("GatProjectLaborCost").glAccountId || null, clearing: account("GatLaborClearing").glAccountId || null}
}

// Post the deltas of entries' bases: one transaction per organization and project, a debit and a credit per entry (a
// negative delta reverses: credit cost, debit clearing), on the given book day. A transaction that does not post stays in
// the error journal with its reason, and the entries wait on it. Answers each entry's transaction.
function postDeltas(bases, day, description) {
    const groups = new Map()
    for (const entry of bases) {
        if (entry.skipped || entry.failureCode || entry.delta.isZero()) continue
        const key = entry.organizationPartyId + "|" + (entry.workEffortId || "")
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(entry)
    }
    const posted = {}
    for (const entries of groups.values()) {
        const {organizationPartyId, workEffortId, currencyUomId} = entries[0]
        const {cost, clearing} = accounts(organizationPartyId)
        const created = call("mantle.ledger.LedgerServices.create#AcctgTrans", {
            acctgTransTypeEnumId: "AttWorkEffortCost",
            organizationPartyId,
            workEffortId,
            amountUomId: currencyUomId,
            transactionDate: ec.user.nowTimestamp,
            description: description || "Project cost of approved time"
        })
        const acctgTransId = created.acctgTransId
        call("update#mantle.ledger.transaction.AcctgTrans", {acctgTransId, accountingDate: day})
        for (const entry of entries) {
            const reverse = entry.delta.compare(0) < 0
            const amount = reverse ? entry.delta.negate() : entry.delta
            for (const [glAccountId, glAccountTypeEnumId, flag] of [
                [cost, "GatProjectLaborCost", reverse ? "C" : "D"],
                [clearing, "GatLaborClearing", reverse ? "D" : "C"]
            ])
                call("mantle.ledger.LedgerServices.create#AcctgTransEntry", {
                    acctgTransId,
                    glAccountId,
                    glAccountTypeEnumId,
                    debitCreditFlag: flag,
                    amount,
                    description: "Time entry " + entry.timeEntryId
                })
        }
        call("mantle.ledger.LedgerServices.post#AcctgTrans", {acctgTransId, reviewed: true})
        const tx = one("mantle.ledger.transaction.AcctgTrans", {acctgTransId})
        if (tx.isPosted !== "Y" && !tx.postingFailureCode)
            call("update#mantle.ledger.transaction.AcctgTrans", {
                acctgTransId,
                postingFailureCode: !cost || !clearing ? "MAPPING_MISSING" : "POSTING_FAILED",
                postingFailureMessage: !cost || !clearing ? "Map project labor cost and labor clearing in posting defaults" : null
            })
        for (const entry of entries) {
            record(entry, acctgTransId)
            posted[entry.timeEntryId] = acctgTransId
        }
    }
    return posted
}
// The entry's operation record gains the transaction line; it is created on the entry's first posting.
function record(entry, acctgTransId) {
    const lines = (entry.posted.record.lines || []).concat([{acctgTransId, amount: String(entry.delta)}])
    const resultJson = JSON.stringify({
        organizationPartyId: entry.organizationPartyId,
        workEffortId: entry.workEffortId,
        timesheetId: entry.timesheetId,
        lines
    })
    if (entry.posted.row || one(OP, {operationKey: operationKey(entry.timeEntryId)}))
        call("update#" + OP, {operationKey: operationKey(entry.timeEntryId), resultJson, completedDate: ec.user.nowTimestamp})
    else
        call("create#" + OP, {
            operationKey: operationKey(entry.timeEntryId),
            operationType: "WorkEffortCost",
            organizationPartyId: entry.organizationPartyId,
            userId: ec.user.userId,
            submittedDate: ec.user.nowTimestamp,
            completedDate: ec.user.nowTimestamp,
            requestHash: lib.hash({timeEntryId: entry.timeEntryId}),
            status: "complete",
            resultEntityName: ENTRY,
            resultId: entry.timeEntryId,
            resultJson
        })
}

// post#WorkEffortCost: the time entries of a timesheet, of a list, or of a project's work, brought to what should be
// posted, on today's book day. Each entry is read under the lock of its operation record.
function post(p) {
    let entries
    const timeEntryIds = p.timeEntryIdList ? Array.from(p.timeEntryIdList) : []
    if (timeEntryIds.length) entries = Array.from(find(ENTRY).condition("timeEntryId", "in", timeEntryIds).list())
    else if (p.timesheetId) entries = rows(ENTRY, {timesheetId: p.timesheetId})
    else if (p.workEffortId)
        entries = Array.from(
            find(ENTRY)
                .condition(
                    ec.entity.conditionFactory.makeCondition(
                        [
                            ec.entity.conditionFactory.makeCondition("workEffortId", "equals", p.workEffortId),
                            ec.entity.conditionFactory.makeCondition(
                                "workEffortId",
                                "in",
                                Array.from(
                                    find("mantle.work.effort.WorkEffort", {rootWorkEffortId: p.workEffortId})
                                        .selectField("workEffortId")
                                        .list()
                                ).map(row => row.workEffortId)
                            )
                        ],
                        "or"
                    )
                )
                .list()
        )
    else throw new Error("Choose a timesheet, time entries or a project")
    const day = p.accountingDate ? lib.calendarDateText(p.accountingDate) : lib.bookDay(null, ec.user.nowTimestamp)
    const bases = entries
        .sort((a, b) => a.timeEntryId.localeCompare(b.timeEntryId))
        .map(entry => basis(entry, true, !!p.deleting))
    const posted = postDeltas(bases, day, p.timesheetId ? "Project cost of timesheet " + p.timesheetId : null)
    const ids = [...new Set(Object.values(posted))]
    return {
        acctgTransId: ids[0] || null,
        acctgTransIdList: ids,
        failedTimeEntryIdList: bases.filter(b => b.failureCode).map(b => b.timeEntryId)
    }
}

// The approved project time of an organization dated in a range whose posting differs from its cost, or that cannot be
// computed; nothing when project cost posting is off. The checklist row and the project cost period run read it.
function pending(organizationPartyId, fromStamp, afterStamp, sourceIdList = null) {
    if (!enabled(organizationPartyId)) return []
    // the organization's projects and their work first, so only its time is read
    const projectIds = Array.from(
        find("mantle.work.effort.WorkEffort", {ownerPartyId: organizationPartyId, workEffortTypeEnumId: "WetProject"})
            .selectField("workEffortId")
            .list()
    ).map(row => row.workEffortId)
    if (!projectIds.length) return []
    const workIds = projectIds.concat(
        Array.from(
            find("mantle.work.effort.WorkEffort")
                .condition("rootWorkEffortId", "in", projectIds)
                .selectField("workEffortId")
                .list()
        ).map(row => row.workEffortId)
    )
    const sourceIds = sourceIdList ? Array.from(sourceIdList) : []
    const out = []
    for (let start = 0; start < workIds.length; start += 500) {
        let query = find(ENTRY)
            .condition("workEffortId", "in", workIds.slice(start, start + 500))
            .condition("fromDate", "greater-equals", fromStamp)
            .condition("fromDate", "less", afterStamp)
            .condition("timesheetId", "is-not-null", null)
        if (sourceIds.length) query = query.condition("timeEntryId", "in", sourceIds)
        for (const entry of query.orderBy("fromDate,timeEntryId").list()) {
            const entryBasis = basis(entry)
            if (entryBasis.skipped || entryBasis.organizationPartyId !== organizationPartyId) continue
            if (!entryBasis.failureCode && entryBasis.delta.isZero()) continue
            out.push(entryBasis)
        }
    }
    return out
}

// The project cost period run (PeriodRunKind PrkProjectCost): a result per pending entry of the period.
function calculateRun(p) {
    const period = one("mantle.party.time.TimePeriod", {timePeriodId: p.timePeriodId})
    const day = lib.calendarDateText(period.thruDate)
    const fromStamp = ec.l10n.parseTimestamp(lib.calendarDateText(period.fromDate), "yyyy-MM-dd")
    const afterStamp = ec.l10n.parseTimestamp(lib.calendarDateText(Date.parse(day) + 86400000), "yyyy-MM-dd")
    const found = accounts(p.organizationPartyId)
    return pending(p.organizationPartyId, fromStamp, afterStamp, p.sourceIdList).map(entry => ({
        sourceEntityName: ENTRY,
        sourceId: entry.timeEntryId,
        description: "Time entry " + entry.timeEntryId + (entry.workEffortId ? " of " + entry.workEffortId : ""),
        amount: entry.failureCode ? null : String(entry.delta),
        debitGlAccountId: found.cost,
        creditGlAccountId: found.clearing,
        failureCode: entry.failureCode || null,
        failureMessage: entry.failureMessage || null
    }))
}
// Post a previewed project cost run: its ready results' entries brought to their cost on the run's book day.
// Post a previewed project cost run: each ready result's entry brought to its cost on the run's book day, in its own
// transaction (define#RunPosting), so one that fails leaves the others posted.
function postRun(p) {
    const run = one("mantle.ledger.transaction.AccountingPeriodRun", {periodRunId: p.periodRunId})
    const results = rows("mantle.ledger.transaction.AccountingPeriodRunResult", {
        periodRunId: p.periodRunId,
        statusId: "PrrReady"
    })
    let postedCount = 0,
        failedCount = 0
    for (const result of results) {
        let acctgTransId = null,
            failure = null
        ec.message.pushErrors()
        try {
            const out =
                ec.service
                    .sync()
                    .name("mantle.ledger.OtherAutoPostServices.post#WorkEffortCost")
                    .parameters({timeEntryIdList: [result.sourceId], accountingDate: run.effectiveDate})
                    .disableAuthz()
                    .requireNewTransaction(true)
                    .call() || {}
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            acctgTransId = out.acctgTransId || null
        } catch (error) {
            ec.logger.error("Project cost run " + run.periodRunId + " time entry " + result.sourceId + ": " + error.message)
            failure = String(error.message)
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
        const tx = acctgTransId ? one("mantle.ledger.transaction.AcctgTrans", {acctgTransId}) : null
        const ok = tx?.isPosted === "Y"
        if (ok) postedCount++
        else failedCount++
        call("update#mantle.ledger.transaction.AccountingPeriodRunResult", {
            periodRunId: result.periodRunId,
            resultSeqId: result.resultSeqId,
            statusId: ok ? "PrrPosted" : "PrrFailed",
            acctgTransId: acctgTransId || null,
            failureCode: ok ? null : tx?.postingFailureCode || (failure ? "POSTING_FAILED" : "NOTHING_TO_POST"),
            failureMessage: ok ? null : failure || tx?.postingFailureMessage || "The time's cost changed; recalculate"
        })
    }
    return {postedCount, failedCount}
}

const operations = {post, calculateRun, postRun}
;({
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown project cost operation " + op)
        return operations[op](parameters)
    },
    pending,
    projectOf
})
