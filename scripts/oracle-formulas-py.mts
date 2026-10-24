/**
 * Second, independent formula oracle (TT15): the PyPI `formulas` package
 * (Python Excel interpreter, EUPL-1.1, used ONLY as an out-of-process dev-time
 * oracle; nothing ships). Captures values for a vector set that targets the
 * extended library imported from the competing repo, plus a cross-check sample
 * of first-party functions. Frozen to docs/test-fixtures/formula-oracle-py.json;
 * scripts/oracle-parity.mts replays it against the current engine.
 *
 * Run (needs a venv with `formulas`): ORACLE_PY=/home/user/tools/venv/bin/python \
 *   node --experimental-strip-types --no-warnings scripts/oracle-formulas-py.mts
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

export const PY_VECTORS: string[] = [
  // financial
  "=PMT(0.05/12,360,200000)", "=PMT(0.08,10,-5000,0,1)", "=FV(0.06/12,120,-100)", "=PV(0.07,20,-1000)", "=NPV(0.1,100,100)",
  "=IRR({-100,30,40,50})", "=SLN(10000,1000,5)", "=SYD(10000,1000,5,2)", "=DDB(10000,1000,5,1)", "=NPER(0.01,-100,1000)", "=RATE(36,-300,9000)",
  "=IPMT(0.1/12,1,36,8000)", "=PPMT(0.1/12,1,36,8000)", "=EFFECT(0.0525,4)", "=NOMINAL(0.053543,4)",
  // math
  "=SUMPRODUCT({1,2,3},{4,5,6})", "=CEILING(4.3,2)", "=FLOOR(4.7,2)", "=FACT(6)", "=FACTDOUBLE(7)", "=GCD(24,36)", "=LCM(4,6)", "=COMBIN(10,3)",
  "=PERMUT(10,3)", "=MULTINOMIAL(2,3,4)", "=ROMAN(1999)", "=ARABIC(\"MCMXCIX\")", "=BASE(255,16)", "=DECIMAL(\"FF\",16)", "=EVEN(3)", "=ODD(2)",
  "=MROUND(10,3)", "=QUOTIENT(7,2)", "=SUMSQ(3,4)", "=RADIANS(180)", "=DEGREES(PI())", "=SINH(1)", "=COSH(1)", "=TANH(0.5)", "=ATAN2(1,1)",
  "=CEILING.MATH(-4.3)", "=FLOOR.MATH(-4.3)", "=ISEVEN(4)", "=ISODD(4)", "=SQRTPI(2)", "=SERIESSUM(2,1,1,{1,2,3})",
  // statistics
  "=STDEV.S({1,5,9})", "=STDEV.P({1,5,9})", "=VAR.S({2,4,4,4,5,5,7,9})", "=VAR.P({2,4,4,4,5,5,7,9})", "=LARGE({3,9,1,4},2)", "=SMALL({3,9,1,4},2)",
  "=MODE.SNGL({1,2,2,3})", "=GEOMEAN({2,8})", "=HARMEAN({1,2,4})", "=PERCENTILE.INC({1,2,3,4,5},0.3)", "=QUARTILE.INC({1,2,3,4,5,6,7,8},1)",
  "=PERCENTRANK.INC({1,2,3,4,5},3)", "=RANK.EQ(4,{3,9,1,4})", "=TRIMMEAN({1,2,3,4,5,6,7,8,9,100},0.2)", "=CORREL({1,2,3,4},{2,4,5,9})",
  "=PEARSON({1,2,3,4},{2,4,5,9})", "=SLOPE({2,4,5,9},{1,2,3,4})", "=INTERCEPT({2,4,5,9},{1,2,3,4})", "=RSQ({2,4,5,9},{1,2,3,4})",
  "=FORECAST.LINEAR(5,{2,4,5,9},{1,2,3,4})", "=STEYX({2,4,5,9},{1,2,3,4})", "=AVEDEV({2,4,4,9})", "=DEVSQ({2,4,4,9})", "=KURT({1,2,3,4,10})",
  "=SKEW({1,2,3,4,10})", "=NORM.S.DIST(1,TRUE)", "=NORM.DIST(1,0,1,FALSE)", "=NORM.INV(0.9,0,1)", "=NORM.S.INV(0.975)", "=CONFIDENCE.NORM(0.05,2.5,50)",
  "=MAXA({1,2})", "=MINA({1,2})", "=COUNTIF({1,2,3,4},\">2\")", "=AVERAGEA({1,2,3})",
  // text
  "=TEXTJOIN(\"-\",TRUE,{\"a\",\"\",\"c\"})", "=TEXTJOIN(\"-\",FALSE,{\"a\",\"\",\"c\"})", "=CHAR(65)", "=CODE(\"A\")", "=UNICHAR(9731)", "=UNICODE(\"☃\")",
  "=CLEAN(\"a\"&CHAR(7)&\"b\")", "=NUMBERVALUE(\"1.234,5\",\",\",\".\")", "=T(\"x\")", "=FIXED(1234.567,1)", "=DOLLAR(1234.567,2)",
  "=TEXTBEFORE(\"a-b-c\",\"-\")", "=TEXTAFTER(\"a-b-c\",\"-\")", "=TEXTAFTER(\"a-b-c\",\"-\",-1)", "=SWITCH(2,1,\"one\",2,\"two\",\"other\")",
  // engineering / information
  "=DEC2BIN(9,4)", "=DEC2BIN(-100)", "=DEC2HEX(-54)", "=HEX2DEC(\"FFFFFFFF5B\")", "=BIN2DEC(1111111111)", "=DEC2OCT(58,3)", "=OCT2DEC(\"7777777533\")",
  "=HEX2BIN(\"F\",8)", "=BIN2HEX(11111011,4)", "=BITAND(13,25)", "=BITOR(23,10)", "=BITXOR(5,3)", "=BITLSHIFT(4,2)", "=BITRSHIFT(13,2)",
  "=DELTA(5,5)", "=GESTEP(5,4)", "=ISNONTEXT(1)", "=ISERR(NA())", "=ERROR.TYPE(1/0)", "=TYPE(\"a\")", "=N(TRUE)",
  // date
  "=DATEDIF(DATE(2020,1,15),DATE(2024,3,10),\"Y\")", "=DATEDIF(DATE(2020,1,15),DATE(2024,3,10),\"M\")", "=DATEDIF(DATE(2020,1,15),DATE(2024,3,10),\"MD\")",
  "=NETWORKDAYS(DATE(2024,1,1),DATE(2024,1,31))", "=WORKDAY(DATE(2024,1,1),10)", "=DAYS(DATE(2024,3,1),DATE(2024,2,1))", "=WEEKNUM(DATE(2024,3,10))",
  "=ISOWEEKNUM(DATE(2024,1,1))", "=YEARFRAC(DATE(2024,1,1),DATE(2024,7,1))", "=DAYS360(DATE(2024,1,31),DATE(2024,3,1))", "=EDATE(DATE(2024,1,31),1)",
  "=EOMONTH(DATE(2024,2,10),0)", "=TIME(12,30,0)", "=HOUR(0.75)", "=MINUTE(0.7604166667)", "=SECOND(TIME(1,2,3))", "=DATEVALUE(\"2024-03-10\")",
  // lookup over literals
  "=XLOOKUP(3,{1,2,3},{\"a\",\"b\",\"c\"})", "=XMATCH(3,{1,2,3})", "=INDEX({1,2;3,4},2,1)", "=MATCH(3,{1,2,3},0)", "=CHOOSE(2,\"a\",\"b\")",
  "=ROWS({1,2;3,4;5,6})", "=COLUMNS({1,2;3,4;5,6})", "=LOOKUP(2.5,{1,2,3},{\"a\",\"b\",\"c\"})",
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const py = process.env.ORACLE_PY ?? "/home/user/tools/venv/bin/python";
  const ver = execFileSync(py, ["-c", "import formulas;print(formulas.__version__)"]).toString().trim();
  const raw = execFileSync(py, ["scripts/oracles/formulas_oracle.py"], { input: JSON.stringify(PY_VECTORS), stdio: ["pipe", "pipe", "ignore"], maxBuffer: 1 << 26 }).toString();
  const rows = JSON.parse(raw) as { formula: string; ok: boolean }[];
  writeFileSync("docs/test-fixtures/formula-oracle-py.json", JSON.stringify({
    oracle: `PyPI formulas ${ver}`, capturedAt: new Date().toISOString(),
    method: "formulas.Parser().ast(f)[1].compile()() per vector; values normalised by scripts/oracles/formulas_oracle.py. Dev-time oracle only.",
    vectors: rows,
  }, null, 1));
  console.log(`captured ${rows.length} vectors, ${rows.filter((r) => r.ok).length} evaluated by the oracle, ${rows.filter((r) => !r.ok).length} unsupported there`);
}
