/*
 * Copyright (C) 2018, 2020 Oracle and/or its affiliates. All rights reserved.
 *
 * Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl
 *
 * Please see LICENSE.txt file included in the top-level directory of the
 * appropriate download for a copy of the license and additional information.
 */

'use strict';

const expect = require('chai').expect;
const util = require('util');

const PreparedStatement = require('../../index').PreparedStatement;
const NoSQLArgumentError = require('../../index').NoSQLArgumentError;
const Consistency = require('../../index').Consistency;
const ErrorCode = require('../../index').ErrorCode;
const NoSQLError = require('../../index').NoSQLError;
const Limits = require('../../lib/constants').Limits;
const badMillis = require('./common').badMillis;
const badConsistencies = require('./common').badConsistencies;
const badStrings = require('./common').badStrings;
const badPosInt32NotNull = require('./common').badPosInt32NotNull;
const badNonNegInt32NotNull = require('./common').badNonNegInt32NotNull;
const badBinaries = require('./common').badBinaries;
const _id = require('./common')._id;
const _version = require('./common')._version;
const _putTime = require('./common')._putTime;
const badOptions = require('./common').badOptions;
const Utils = require('./utils');
const QueryUtils = require('./query_utils');
const QUERY_TESTS = require('./query_tests');

const negativeTestTable = require('./test_schemas').SIMPLE_TABLE;

const compartment = Utils.config.compartment;

const badPrepareStmts = [
    ...badStrings,
    'SELECT blah blah' //invalid SQL string
];

const badPrepareOpts = [
    ...badOptions,
    ...badMillis.map(timeout => ({ timeout }))
];

const badMaxReadKB = badPosInt32NotNull.concat(Limits.READ_KB + 1);
const badMaxWriteKB = badPosInt32NotNull.concat(Limits.WRITE_KB + 1);
const badTraceLevel = badNonNegInt32NotNull.concat(33);

const badCursorOpts = [
    ...badOptions,
    ...badMillis.map(timeout => ({ timeout })),
    ...badConsistencies.map(consistency => ({ consistency })),
    ...badNonNegInt32NotNull.map(limit => ({ limit })),
    ...badMaxReadKB.map(maxReadKB => ({ maxReadKB })),
    ...badMaxWriteKB.map(maxWriteKB => ({ maxWriteKB })),
    ...badPosInt32NotNull.map(maxMemoryMB => ({ maxMemoryMB })),
    ...badTraceLevel.map(traceLevel => ({ traceLevel }))
];

const badQueryOpts = [
    ...badCursorOpts,
    ...badBinaries.map(continuationKey => ({ continuationKey }))
    //UNKNOWN_ERROR is returned currently by the proxy on the following:
    //{ continuationKey: Buffer.alloc(16) } //bogus continuation key
];

const badVars = badStrings;

const badBindings = [
    null,
    [],
    {},
    Buffer.alloc(16),
    {
        '$ln' : 'a' //missing binding for "$fn"
    },
    {
        '$ln': 'a',
        '$fn': 'b',
        'junk': 1 //undeclared variable
    },
    {
        '$ln': 1,
        '$fn': () => (() => {}) //function returning function, not allowed
    }
];

const badQueryStmts = [
    ...badPrepareStmts,
    //fake empty instance of PreparedStatement
    Object.create(PreparedStatement.prototype),
    //fake instances of PreparedStatement with invalid binary content
    //(_prepStmt property), still need to return correct error
    [
        null,
        ...badBinaries,
        Buffer.alloc(32)
    ].map(_prepStmt => Object.assign(Object.create(
        PreparedStatement.prototype), { _prepStmt }))
];

function testPrepareNegative(client) {
    for(let badStmt of badPrepareStmts) {
        it(`Prepare with invalid statement: ${util.inspect(badStmt)}`,
            async function() {
                return expect(client.prepare(badStmt)).to.be.rejectedWith(
                    NoSQLArgumentError);
            });
    }

    const badStmt = 'SELECT * FROM nosuchtable';
    it(`Prepare with non-existent table: ${badStmt}`, async function() {
        return expect(client.prepare(badStmt)).to.eventually.be.rejected.and
            .satisfy(err => err instanceof NoSQLError &&
            err.errorCode == ErrorCode.TABLE_NOT_FOUND);
    });

    const stmt = `DECLARE $fn string; $ln string; SELECT * FROM \
${negativeTestTable.name} WHERE firstName = $fn AND lastName = $ln`;

    for(let badOpt of badPrepareOpts) {
        it(`Prepare with invalid options: ${util.inspect(badOpt)}`,
            async function() {
                return expect(client.prepare(stmt, badOpt)).to.be
                    .rejectedWith(NoSQLArgumentError);
            });
    }

    describe('Prepare with invalid variables and bindings', function() {
        let prepStmt;
        before(async function() {
            prepStmt = await client.prepare(stmt);
        });
        beforeEach(function() {
            prepStmt.clearAll();
        });
        for(let badVar of badVars) {
            it(`Prepare with invalid variable name: ${util.inspect(badVar)}`,
                async function() {
                    return expect(client.query(prepStmt)).to.be.rejectedWith(
                        NoSQLArgumentError);
                });
        }
        for(let badBinding of badBindings) {
            it(`Prepare with invalid bindings: ${util.inspect(badBinding)}`,
                async function() {
                    return expect(client.query(prepStmt)).to.be.rejectedWith(
                        NoSQLArgumentError);
                });
        }
    });
}

function testQueryFuncNegative(queryFunc, badOpts) {
    for(let badStmt of badQueryStmts) {
        it(`${queryFunc._name} with invalid statement: \
${util.inspect(badStmt)}`, async function() {
            return expect(queryFunc(badStmt)).to.be.rejectedWith(
                NoSQLArgumentError);
        });
    }

    for(let badOpt of badOpts) {
        it(`${queryFunc._name} with invalid options: ${util.inspect(badOpt)}`,
            async function() {
                return expect(queryFunc(`SELECT * FROM ${negativeTestTable.name}`,
                    badOpt)).to.be.rejectedWith(NoSQLArgumentError);
            });
    }
}

function testQueryCursorNegative(client) {
    const queryFunc = client.query.bind(client);
    queryFunc._name = 'query';
    testQueryFuncNegative(queryFunc, badQueryOpts);

    const cursorFunc = async (stmt, opt) => {
        await client.cursor(stmt, opt).next();
    };
    cursorFunc._name = 'cursor';
    testQueryFuncNegative(cursorFunc, badCursorOpts);
}

function verifyPrepareResult(res) {
    expect(res).to.be.an('object');
    Utils.verifyConsumedCapacity(res.consumedCapacity);
    if (!Utils.isOnPrem) {
        expect(res.consumedCapacity.readKB).to.be.at.least(1);
        expect(res.consumedCapacity.readUnits).to.be.at.least(1);
        expect(res.consumedCapacity.writeKB).to.equal(0);
        expect(res.consumedCapacity.writeUnits).to.equal(0);
        expect(res._prepStmt).to.be.instanceOf(Buffer);
        expect(res._prepStmt.length).to.be.greaterThan(0);
    }
}

function getUnmodifiedRows(test, updatedRows) {
    if (typeof updatedRows[0] !== 'number') {
        updatedRows = updatedRows.map(row => row[_id]);
    }
    const updSet = new Set(updatedRows);
    return test.rows.filter(row => !updSet.has(row[_id]));
}

//Verify CC after query is done.  For advanced queries,
//verifying consumed capacity after each query() call is not reliable
//based on returned rows or updated rows, since driver's query engine could
//cache some results.  So we just add up CC over all query() calls for
//the query and verify the totals.
function verifyCCTotals(state, opt, updatedRows) {
    expect(state.readKB).to.be.at.least(state.rows.length);
    let readUnits = state.rows.length;
    if (opt.consistency === Consistency.ABSOLUTE) {
        readUnits *= 2;
    }
    expect(state.readUnits).to.be.at.least(readUnits);
    if (updatedRows) {
        expect(state.writeKB).to.be.at.least(updatedRows.length);
        expect(state.writeUnits).to.be.at.least(updatedRows.length);
    } else {
        expect(state.writeKB).to.equal(0);
        expect(state.writeUnits).to.equal(0);
    }
}

function verifyResultRows(rows, table, expectedRows, expectedFields,
    unordered) {
    expect(rows.length).to.equal(expectedRows.length);

    //Current limitation: if query returns unordered results and more than
    //one row, assume that result columns contain primary key so that we can
    //correctly sort both expected and result rows
    if (unordered) {
        rows = QueryUtils.sortRows(rows, ...table.primaryKey);
        expectedRows = QueryUtils.sortRows(expectedRows, ...table.primaryKey);
    }

    for(let i = 0; i < rows.length; i++) {
        Utils.verifyRow(rows[i], expectedRows[i], table, expectedFields);
    }
}

//readKB statement preparation cost
const PREP_READ_KB = 2;

//additional writeKB cost if indexes present, per index
//const IDX_WRITE_KB = 1;

//q - query object, contains info about given query
//tc - query test case, the same query may be performed with different values
//of bound variables.  See comments before testQuery().
//tc.expectedRows is the query result
//tc.updatedRows, for insert and update queries, are what the inserted/updated
//rows supposed to be in DB after the query execution (currently either 1 or
//0 rows).  For delete queries, updatedRows is an array of row ids (numbers)
//that were deleted by the query.
//state - keeps some info across query calls for the same query execution
async function verifyQueryResult(res, client, test, q, tc, opt, state) {
    if (!opt) {
        opt = {};
    }
    if (state.rows == null) {
        state.rows = [];
        state.readUnits = 0;
        state.readKB = 0;
        state.writeKB = 0;
        state.writeUnits = 0;
    }
    expect(res).to.be.an('object');
    expect(res.rows).to.be.an('array');

    if (res.continuationKey == null) {
        expect(res.rows.length).to.equal(tc.expectedRows.length -
            state.rows.length);
    } else {
        expect(res.rows.length).to.be.at.most(tc.expectedRows.length -
            state.rows.length);
        if (opt.limit) {
            expect(res.rows.length).to.be.at.most(opt.limit);
        }
    }

    Utils.verifyConsumedCapacity(res.consumedCapacity);
    if (!Utils.isOnPrem) {
        if (opt.maxReadKB && (tc.bindings || state.rows.length)) {
            let maxReadKB = opt.maxReadKB + test.maxRowKB;
            //On the first query call of un-prepared queries we need to add
            //the preparation cost (2KB)
            if (!tc.bindings && !state.rows.length) {
                maxReadKB += PREP_READ_KB;
            }
            expect(res.consumedCapacity.readKB).to.be.at.most(maxReadKB);
        }
        /*
        if (opt.maxWriteKB) {
            let maxWriteKB = opt.maxWriteKB + test.maxRowKB;
            if (test.table.indexes) {
                maxWriteKB += test.table.indexes.length * IDX_WRITE_KB;
            }
            expect(res.consumedCapacity.writeKB).to.be.at.most(maxWriteKB);
        }
        */
        state.readKB += res.consumedCapacity.readKB;
        state.readUnits += res.consumedCapacity.readUnits;
        state.writeKB += res.consumedCapacity.writeKB;
        state.writeUnits += res.consumedCapacity.writeUnits;
    }

    state.rows = state.rows.concat(res.rows);

    //The rest is verified only after the last query() call
    if (res.continuationKey != null) {
        return;
    }

    verifyResultRows(state.rows, test.table, tc.expectedRows,
        tc.expectedFields, q.unordered);

    if (!Utils.isOnPrem) {
        verifyCCTotals(state, opt, tc.updatedRows);
    }

    if (tc.updatedRows && tc.updatedRows.length) {
        const currDate = new Date();
        for(let row of tc.updatedRows) {
            let pk;
            if (typeof row === 'number') { //delete query
                pk = test.ptr2pk(row);
                row = null;
            } else {
                if (opt._updateTTL) {
                    row[_putTime] = currDate;
                } else {
                    //Get the putTime from original row
                    const row0 = test.byId.get(row[_id]);
                    //row0 exists for updates, but not for inserts
                    row[_putTime] = row0 ? row0[_putTime] : currDate;
                }
                pk = Utils.makePrimaryKey(test.table, row);
            }
            let res = await client.get(test.table.name, pk);
            //This should verify all modifications, including TTL, but not
            //version, since the query result doesn't tell us updated row
            //versions.  For delete query this will verify that the row
            //no longer exists.
            Utils.verifyGetResult(res, test.table, row, { _skipVerifyVersion:
                true });
        }
        //Verify that the rest of test rows are not modified
        for(let row of getUnmodifiedRows(test, tc.updatedRows)) {
            const getRes = await client.get(test.table.name,
                Utils.makePrimaryKey(test.table, row));
            expect(getRes.row).to.exist;
            expect(getRes.version).to.deep.equal(row[_version]);
        }
    }
}

async function restore(client, test, updatedRows) {
    for(let row of updatedRows) {
        const rowId = (typeof row === 'number') ? row : row[_id];
        const origRow = test.byId.get(rowId);
        if (origRow) { //update or delete statement, restore original row
            await Utils.putRow(client, test.table, origRow);
        } else { //insert statement, delete new row
            await Utils.deleteRow(client, test.table,
                Utils.makePrimaryKey(test.table, row));
        }
    }
}

//q - query object, contains info about given query
//tc - query test case, the same query may be performed with different values
//of bound variables.  See comments before testQuery().
async function doQuery(client, test, q, tc, stmt, opt) {
    delete opt.continuationKey;
    let state = {}; //maintain test-related information accross query calls
    let iterCnt = 0;
    for(;;) {
        const res = await client.query(stmt, opt);
        await verifyQueryResult(res, client, test, q, tc, opt, state);
        if (!res.continuationKey) {
            return;
        }
        opt.continuationKey = res.continuationKey;
        //make sure we don't loop infinitely
        expect(++iterCnt).to.be.lessThan(test.rows.length * 16);
        //If we are using small limit/maxReadKB and duplicate elimination,
        //there can be quite a lot of calls to query() since a lot of results
        //will be skipped by ReceiveIterator.
    }
}

//BatchCursor is not used currently
/*
async function doCursor(client, test, stmt, opt, expectedRows, updatedRows) {
    let startIdx = 0;
    let iterCnt = 0;
    const c = client.cursor(stmt, opt);
    let hasNext = c.hasNext();
    expect(hasNext).to.equal(true);
    for(;;) {
        const res = await c.next();
        await verifyQueryResult(res, client, test, opt, expectedRows,
            startIdx, updatedRows);
        startIdx += res.rows.length;
        hasNext = c.hasNext();
        expect(hasNext).to.be.a('boolean');
        if (!hasNext) {
            expect(startIdx).to.equal(expectedRows.length);
            return;
        }
        //make sure we don't loop infinitely
        expect(++iterCnt).to.be.lessThan(test.rows.length + 2);
    }
}
*/

function getQueryOpts(test, q, tc) {
    return [
        undefined,
        {
            timeout: 12000
        },
        {
            consistency: Consistency.ABSOLUTE,
            timeout: 20000,
            compartment
        },
        {
            limit: Math.max(1, Math.floor(tc.expectedRows.length / 3))
        },
        {
            maxReadKB: q.maxReadKB ? q.maxReadKB :
                (test.maxRowKB ? (test.maxRowKB + 1) : 3)
        },
        {
            limit: 3,
            maxReadKB: q.maxReadKB ? q.maxReadKB : 4
        },
        {
            maxWriteKB: q.maxWriteKB ? q.maxWriteKB :
                (test.maxRowKB ? (test.maxRowKB + 1) : 3)
        }
    ];
}

//verify testcase for correctness
function chkTestCase(tc) {
    if (tc.expectedRows == null) {
        tc.expectedRows = [];
    }
    expect(tc.expectedRows).to.be.an('array');
    if (tc.updatedRows != null) {
        expect(tc.updatedRows).to.be.an('array');
    }
}

function doBind(ps, bindings) {
    if (bindings) {
        //vary how we bind
        if (Object.keys(bindings).length <= 1) {
            ps.bindings = bindings;
        } else {
            for(let key in bindings) {
                ps.set(key, bindings[key]);
            }
        }
    }
}

//q should contain the following:
//q.stmt - query statement string
//q.updateTTL - true/false whether the query is an update and it updates TTL
//of the rows (in which case we have to update the put time)
//q.testCases - array of test cases to perform.  We may perform the same query
//multiple times with different values for bind variables.  Each test must
//contain:
//testCase.bindings - bindings object for given execution - may be absent if
//there are no bindings
//testCase.expectedRows - expected returned rows for given execution, for
//update query this would be result of the RETURNING clause or a record with
//number of updated rows
//testCase.updatedRows - set of updated rows if the query is an update,
//undefined otherwise.  Updated row id should be the same as original row id
//so that the row may be restored after each test case.
//About the last property - currently update queries can only update at
//most 1 row, but for the sake of generality I assume here that multiple rows
//may be updated, perhaps this feature may be implemented in future.  Also
//additional work would be required here if in future we allow queries to
//insert new rows or delete existing rows.
//For simplicity, we allow q.testCases to be undefined, in which case there is
//only one test case and the test parameters are part of q itsef (basically
//q.testCases = [ q ])

function testQuery(client, test, q) {
    const tcs = q.testCases ? q.testCases : [ q ];

    //Since we may run the same test on different tables (as longs as the
    //query is valid for them), instead of fixing table name in the query
    //string, we use __TABLE__ which we replace with real table name here.
    const stmt = q.stmt.replace('__TABLE__', test.table.name);

    //For queries without bind variables, we will execute them directly,
    //in addition to using PreparedStatement
    if (tcs.length === 1 && !tcs[0].bindings) {
        const tc = tcs[0];
        chkTestCase(tc);
        describe(`Direct execution of query: ${stmt}`, function() {
            afterEach(async function() {
                if (tc.updatedRows) {
                    await restore(client, test, tc.updatedRows);
                }
            });
            for(let opt of getQueryOpts(test, q, tc)) {
                for(let queryFunc of [ doQuery ]) {
                    it(`Direct execution of query: ${stmt} via \
    ${queryFunc.name} with options: ${util.inspect(opt)}`, async function() {
                        //Make a copy of opt to avoid async concurrency
                        //problems
                        opt = Object.assign({ _updateTTL: q.updateTTL }, opt);
                        await queryFunc(client, test, q, tc, stmt, opt);
                    });
                }
            }
        });
    }

    it(`Prepare query: ${stmt}`, async function() {
        const ps = await client.prepare(stmt, {
            timeout: 10000,
            compartment
        });
        verifyPrepareResult(ps);
    });

    describe(`Prepared query execution: ${stmt}`, function() {
        let ps;
        before(async function() {
            ps = await client.prepare(stmt);
        });
        for(let tc of tcs) {
            chkTestCase(tc);
            describe(`Execution of query: ${stmt} with bindings:
${util.inspect(tc.bindings)}`, function() {
                before(function() {
                    doBind(ps, tc.bindings);
                });
                afterEach(async function() {
                    if (tc.updatedRows) {
                        await restore(client, test, tc.updatedRows);
                    }
                });
                for(let opt of getQueryOpts(test, q, tc)) {
                    for(let queryFunc of [ doQuery ]) {
                        it(`Execution of prepared query: ${stmt} via \
${queryFunc.name} with options: ${util.inspect(opt)}`, async function() {
                            opt = Object.assign({ _updateTTL: q.updateTTL },
                                opt);
                            await queryFunc(client, test, q, tc, ps, opt);
                        });
                    }
                }
            });
        }
    });
}

function doTest(client, test) {
    describe(`Running ${test.desc}`, function() {
        before(async function() {
            await Utils.createTable(client, negativeTestTable);
            await Utils.dropTable(client, test.table);
            await Utils.createTable(client, test.table, true);
            for(let row of test.rows) {
                await Utils.putRow(client, test.table, row);
            }
        });
        after(async function() {
            await Utils.dropTable(client, negativeTestTable);
            await Utils.dropTable(client, test.table);
        });
        testPrepareNegative(client);
        testQueryCursorNegative(client);
        test.queries.forEach(q => testQuery(client, test, q));
    });
}

function doTestcase(idx, client, test) {
    if (idx < 0) {
        idx = test.queries.length + idx;
    }
    const query = test.queries[idx];
    expect(query).to.exist;
    describe(`Running ${test.desc}, query ${query.desc}`, function() {
        before(async function() {
            await Utils.dropTable(client, test.table);
            await Utils.createTable(client, test.table, true);
            for(let row of test.rows) {
                await Utils.putRow(client, test.table, row);
            }
        });
        after(async function() {
            await Utils.dropTable(client, test.table);
        });
        testQuery(client, test, query);
    });
}

const testIdx = Number(Utils.getArgVal('--test-index'));
const queryIdx = Number(Utils.getArgVal('--query-index'));

if (Number.isInteger(testIdx)) {
    const test = QUERY_TESTS[testIdx];
    expect(test).to.exist;
    if (Number.isInteger(queryIdx)) {
        Utils.runSequential('prepare/query testcase',
            doTestcase.bind(null, queryIdx),
            [ test ]);
    } else {
        Utils.runSequential('prepare/query test', doTest, [ test ]);
    }
} else {
    Utils.runSequential('prepare/query tests', doTest, QUERY_TESTS);
}
