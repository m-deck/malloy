/*
 * Copyright 2021 Google LLC
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * version 2 as published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 */

import { URL } from "url";
import { cloneDeep } from "lodash";
import * as model from "../../model/malloy_types";
import { Segment as ModelQuerySegment } from "../../model/malloy_query";
import {
  FieldSpace,
  ReduceFieldSpace,
  ProjectFieldSpace,
  NewFieldSpace,
  QueryFieldSpace,
} from "../field-space";
import * as Source from "../source-reference";
import { LogMessage, MessageLogger } from "../parse-log";
import { MalloyTranslation } from "../parse-malloy";
import { toTimestampV } from "./time-utils";
import {
  compressExpr,
  ConstantSubExpression,
  ExprFieldDecl,
  ExpressionDef,
} from "./index";

/*
 ** For times when there is a code generation error but your function needs
 ** to return some kind of object to type properly, the ErrorFactory is
 ** here to help you.
 */
class ErrorFactory {
  static get structDef(): model.StructDef {
    const ret: model.StructDef = {
      type: "struct",
      name: "undefined_error_structdef",
      structSource: { type: "table" },
      structRelationship: { type: "basetable" },
      fields: [],
    };
    return ret;
  }

  static query(): model.Query {
    return {
      structRef: "undefined_query",
      pipeline: [],
    };
  }
}

type ChildBody = MalloyElement | MalloyElement[];
type ElementChildren = Record<string, ChildBody>;

export abstract class MalloyElement {
  abstract elementType: string;
  codeLocation?: Source.Range;
  children: ElementChildren = {};
  parent: MalloyElement | null = null;
  private logger?: MessageLogger;

  /**
   * @param kids All children passed to the constructor are not optional
   */
  constructor(kids?: ElementChildren) {
    if (kids) {
      this.has(kids);
    }
  }

  /**
   * Record all elements as children of this element, and mark this
   * element as their parent.
   * @param kids Some of these might be undefined, in which case they ae ignored
   */
  has(kids: Record<string, ChildBody | undefined>): void {
    for (const kidName in kids) {
      const kidValue = kids[kidName];
      if (kidValue !== undefined) {
        this.children[kidName] = kidValue;
        if (kidValue instanceof MalloyElement) {
          kidValue.parent = this;
        } else {
          for (const oneKid of kidValue) {
            oneKid.parent = this;
          }
        }
      }
    }
  }

  get location(): Source.Range | undefined {
    if (this.codeLocation) {
      return this.codeLocation;
    }
    if (this.parent) {
      return this.parent.location;
    }
    return undefined;
  }

  set location(loc: Source.Range | undefined) {
    this.codeLocation = loc;
  }

  protected namespace(): NameSpace | undefined {
    if (this instanceof Document) {
      return this;
    } else if (this.parent) {
      return this.parent.namespace();
    }
  }

  modelEntry(str: string): ModelEntry | undefined {
    return this.namespace()?.getEntry(str);
  }

  private xlate?: MalloyTranslation;

  translator(): MalloyTranslation | undefined {
    if (this.xlate) {
      return this.xlate;
    }
    if (this.parent) {
      return this.parent.translator();
    }
    return undefined;
  }

  setTranslator(x: MalloyTranslation): void {
    this.xlate = x;
  }

  log(logString: string): void {
    const trans = this.translator();
    const msg: LogMessage = {
      sourceURL: trans?.sourceURL || "(missing)",
      message: logString,
    };
    const loc = this.location;
    if (loc) {
      msg.begin = loc.begin;
      msg.end = loc.end;
    }
    const logTo = trans?.root.logger;
    if (logTo) {
      logTo.log(msg);
      return;
    }
    throw new Error(
      `Translation error (without error reporter):\n${JSON.stringify(
        msg,
        null,
        2
      )}`
    );
  }

  /**
   * Mostly for debugging / testing. A string-y version of this object which
   * is used to ask "are these two AST segments equal"
   * @param indent only used for recursion
   */
  toString(): string {
    return this.stringify("", 0);
  }

  private stringify(prefix: string, indent: number): string {
    const left = " ".repeat(indent);
    let asString = `${left}${prefix}<${this.elementType}>${this.varInfo()}`;
    for (const kidLabel of Object.keys(this.children)) {
      const kiddle = this.children[kidLabel];
      if (kiddle instanceof MalloyElement) {
        asString += "\n" + kiddle.stringify(`${kidLabel}: `, indent + 2);
      } else {
        asString += `\n${left}  ${kidLabel}: [`;
        if (kiddle.length > 0) {
          asString +=
            "\n" +
            kiddle.map((k) => k.stringify("", indent + 4)).join("\n") +
            `\n${left}  `;
        }
        asString += "]";
      }
    }
    return asString;
  }

  private varInfo(): string {
    let extra = "";
    for (const [key, value] of Object.entries(this)) {
      if (key !== "elementType") {
        if (typeof value == "boolean") {
          extra += value ? ` ${key}` : ` !${key}`;
        } else if (typeof value === "string" || typeof value === "number") {
          extra += ` ${key}=${value}`;
        }
      }
    }
    return extra;
  }

  protected internalError(msg: string): Error {
    this.log(`INTERNAL ERROR IN TRANSLATION: ${msg}`);
    return new Error(msg);
  }
}

export class ListOf<ET extends MalloyElement> extends MalloyElement {
  elementType = "genericElementList";
  private elements: ET[];
  constructor(listDesc: string, elements: ET[]) {
    super();
    this.elements = elements;
    if (this.elementType === "genericElementList") {
      this.elementType = listDesc;
    }
    this.newContents();
  }

  private newContents(): void {
    this.has({ [this.elementType]: this.elements });
  }

  get list(): ET[] {
    return this.elements;
  }

  empty(): boolean {
    return this.elements.length === 0;
  }

  notEmpty(): boolean {
    return this.elements.length > 0;
  }

  push(...el: ET[]): ET[] {
    this.elements.push(...el);
    this.newContents();
    return this.elements;
  }
}

export class Unimplemented extends MalloyElement {
  elementType = "unimplemented";
}

function getStructFieldDef(
  s: model.StructDef,
  fn: string
): model.FieldDef | undefined {
  return s.fields.find((fld) => (fld.as || fld.name) === fn);
}

type FieldDecl = ExprFieldDecl | Join | TurtleDecl | Turtles;
function isFieldDecl(f: MalloyElement): f is FieldDecl {
  return (
    f instanceof ExprFieldDecl ||
    f instanceof Join ||
    f instanceof TurtleDecl ||
    f instanceof Turtles
  );
}

export type ExploreField = FieldDecl | RenameField;
export function isExploreField(f: MalloyElement): f is ExploreField {
  return isFieldDecl(f) || f instanceof RenameField;
}

/**
 * A "Mallobj" is a thing which you can run queries against, it has been called
 * an "exploreable", or a "space".
 */
export abstract class Mallobj extends MalloyElement {
  abstract structDef(): model.StructDef;

  structRef(): model.StructRef {
    return this.structDef();
  }

  withParameters(pList: HasParameter[] | undefined): model.StructDef {
    const before = this.structDef();
    // TODO name collisions are flagged where?
    if (pList) {
      const parameters = { ...(before.parameters || {}) };
      for (const hasP of pList) {
        const pVal = hasP.parameter();
        parameters[pVal.name] = pVal;
      }
      return {
        ...before,
        parameters,
      };
    }
    return before;
  }
}

class QueryHeadStruct extends Mallobj {
  constructor(readonly fromRef: model.StructRef) {
    super();
  }
  structRef(): model.StructRef {
    return this.fromRef;
  }
  structDef(): model.StructDef {
    if (model.refIsStructDef(this.fromRef)) {
      return this.fromRef;
    }
    const ns = new NamedSource(this.fromRef);
    return ns.structDef();
  }
}

export interface DocStatement extends MalloyElement {
  execute(doc: Document): void;
}

export function isDocStatement(e: MalloyElement): e is DocStatement {
  return (e as DocStatement).execute !== undefined;
}

export class DefineExplore extends MalloyElement implements DocStatement {
  elementType = "defineExplore";
  readonly parameters?: HasParameter[];
  constructor(
    readonly name: string,
    readonly mallobj: Mallobj,
    readonly exported: boolean,
    params?: MalloyElement[]
  ) {
    super({ explore: mallobj });
    if (params) {
      this.parameters = [];
      for (const el of params) {
        if (el instanceof HasParameter) {
          this.parameters.push(el);
        } else {
          this.log(
            `Unexpected element type in define statement: ${el.elementType}`
          );
        }
      }
      this.has({ parameters: this.parameters });
    }
  }

  execute(doc: Document): void {
    if (doc.modelEntry(this.name)) {
      this.log(`Cannot redefine '${this.name}'`);
    } else {
      const struct = {
        ...this.mallobj.withParameters(this.parameters),
        as: this.name,
      };
      doc.setEntry(this.name, {
        entry: struct,
        exported: this.exported,
      });
    }
  }
}

/**
 * A Mallobj made from a source and a set of refinements
 */
export class RefinedExplore extends Mallobj {
  elementType = "refinedExplore";

  constructor(readonly source: Mallobj, readonly refinement: ExploreDesc) {
    super({ source, refinement });
  }

  structDef(): model.StructDef {
    return this.withParameters([]);
  }

  withParameters(pList: HasParameter[] | undefined): model.StructDef {
    let primaryKey: PrimaryKey | undefined;
    let fieldListEdit: FieldListEdit | undefined;
    const fields: ExploreField[] = [];
    const filters: Filter[] = [];

    for (const el of this.refinement.list) {
      const errTo = el;
      if (el instanceof PrimaryKey) {
        if (primaryKey) {
          primaryKey.log("Primary key already defined");
          el.log("Primary key redefined");
        }
        primaryKey = el;
      } else if (el instanceof FieldListEdit) {
        if (fieldListEdit) {
          fieldListEdit.log("Too many accept/except statements");
          el.log("Too many accept/except statements");
        }
        fieldListEdit = el;
      } else if (el instanceof RenameField) {
        fields.push(el);
      } else if (
        el instanceof Measures ||
        el instanceof Dimensions ||
        el instanceof Joins ||
        el instanceof Turtles
      ) {
        fields.push(...el.list);
      } else if (el instanceof Filter) {
        filters.push(el);
      } else {
        errTo.log(`Unexpected explore property: '${errTo.elementType}'`);
      }
    }

    const from = cloneDeep(this.source.structDef());
    if (primaryKey) {
      from.primaryKey = primaryKey.field.name;
    }
    const fs = NewFieldSpace.filteredFrom(from, fieldListEdit);
    fs.addField(...fields);
    if (pList) {
      fs.addParameters(pList);
    }
    if (primaryKey) {
      if (!fs.findEntry(primaryKey.field.name)) {
        primaryKey.log(`Undefined field '${primaryKey.field.name}'`);
      }
    }
    const retStruct = fs.structDef();

    const filterList = retStruct.filterList || [];
    let moreFilters = false;
    for (const filter of filters) {
      for (const el of filter.list) {
        const fc = el.filterExpression(fs);
        if (fc.aggregate) {
          el.log("Can't use aggregate computations in top level filters");
        } else {
          filterList.push(fc);
          moreFilters = true;
        }
      }
    }
    if (moreFilters) {
      return { ...retStruct, filterList };
    }
    return retStruct;
  }
}

export class TableSource extends Mallobj {
  elementType = "tableSource";
  constructor(readonly name: string) {
    super();
  }

  structDef(): model.StructDef {
    const tableDefEntry = this.translator()?.root.schemaZone.getEntry(
      this.name
    );
    let msg = `Schema read failure for table '${this.name}'`;
    if (tableDefEntry) {
      if (tableDefEntry.status == "present") {
        return tableDefEntry.value;
      }
      if (tableDefEntry.status == "error") {
        msg = tableDefEntry.message.includes(this.name)
          ? `'Schema error: ${tableDefEntry.message}`
          : `Schema error '${this.name}': ${tableDefEntry.message}`;
      }
    }
    this.log(msg);
    return ErrorFactory.structDef;
  }
}

export class IsValueBlock extends MalloyElement {
  elementType = "isValueBlock";

  constructor(readonly isMap: Record<string, ConstantSubExpression>) {
    super();
    this.has(isMap);
  }
}

export class NamedSource extends Mallobj {
  elementType = "namedSource";
  protected isBlock?: IsValueBlock;

  constructor(
    readonly name: string,
    paramValues: Record<string, ConstantSubExpression> = {}
  ) {
    super();
    if (paramValues && Object.keys(paramValues).length > 0) {
      this.isBlock = new IsValueBlock(paramValues);
      this.has({ parameterValues: this.isBlock });
    }
  }

  structRef(): model.StructRef {
    if (this.isBlock) {
      return this.structDef();
    }
    return this.name;
  }

  structDef(): model.StructDef {
    /*
      Can't really generate the callback list until after all the
      things before me are translated, and that kinda screws up
      the translation process, so that might be a better place
      to start the next step, because how that gets done might
      make any code I write which ignores the translation problem
      kind of meaningless.

      Maybe the output of a tranlsation is something which describes
      all the missing data, and then there is a "link" step where you
      can do other translations and link them into a partial translation
      which might result in a full translation.
    */

    const fromModel = this.modelEntry(this.name);
    if (!fromModel) {
      this.log(`Undefined data source '${this.name}'`);
      return ErrorFactory.structDef;
    }
    const ret = { ...fromModel.entry };
    const declared = { ...ret.parameters } || {};

    const makeWith = this.isBlock?.isMap || {};
    for (const [pName, pExpr] of Object.entries(makeWith)) {
      const decl = declared[pName];
      // const pVal = pExpr.constantValue();
      if (!decl) {
        this.log(`Value given for undeclared parameter '${pName}`);
      } else {
        if (model.isValueParameter(decl)) {
          if (decl.constant) {
            pExpr.log(`Cannot override constant parameter ${pName}`);
          } else {
            const pVal = pExpr.constantValue();
            let value: model.Expr | null = pVal.value;
            if (pVal.dataType !== decl.type) {
              if (decl.type === "timestamp" && pVal.dataType === "date") {
                value = toTimestampV(pVal).value;
              } else {
                pExpr.log(
                  `Type mismatch for parameter '${pName}', expected '${decl.type}'`
                );
                value = null;
              }
            }
            decl.value = value;
          }
        } else {
          // TODO type checking here -- except I am still not sure what
          // datatype half conditions have ..
          decl.condition = pExpr.constantCondition(decl.type).value;
        }
      }
    }
    for (const checkDef in ret.parameters) {
      if (!model.paramHasValue(declared[checkDef])) {
        this.log(`Value not provided for required parameter ${checkDef}`);
      }
    }
    return ret;
  }
}

export class Join extends MalloyElement {
  elementType = "join";
  constructor(
    readonly name: string,
    readonly source: Mallobj,
    readonly key: string
  ) {
    super({ source });
  }

  structDef(): model.StructDef {
    const sourceDef = this.source.structDef();
    const joinStruct: model.StructDef = {
      ...sourceDef,
      structRelationship: {
        type: "foreignKey",
        foreignKey: this.key,
      },
    };
    if (sourceDef.structSource.type === "query") {
      // the name from query does not need to be preserved
      joinStruct.name = this.name;
    } else {
      joinStruct.as = this.name;
    }

    return joinStruct;
  }
}

export class Joins extends ListOf<Join> {
  constructor(joins: Join[]) {
    super("joinList", joins);
  }
}

export type QueryProperty =
  | Ordering
  | Top
  | Limit
  | Filter
  | FieldCollection
  | Nest
  | Nests
  | Aggregate
  | GroupBy;
export function isQueryProperty(q: MalloyElement): q is QueryProperty {
  return (
    q instanceof Ordering ||
    q instanceof Top ||
    q instanceof Limit ||
    q instanceof Filter ||
    q instanceof FieldCollection ||
    q instanceof Aggregate ||
    q instanceof Nests ||
    q instanceof Nest ||
    q instanceof GroupBy
  );
}

export type ExploreProperty =
  | Filter
  | Joins
  | Measures
  | Dimensions
  | FieldListEdit
  | RenameField
  | PrimaryKey
  | Turtles;
export function isExploreProperty(p: MalloyElement): p is ExploreProperty {
  return (
    p instanceof Filter ||
    p instanceof Joins ||
    p instanceof Measures ||
    p instanceof Dimensions ||
    p instanceof FieldListEdit ||
    p instanceof RenameField ||
    p instanceof PrimaryKey ||
    p instanceof Turtles
  );
}
export class ExploreDesc extends ListOf<ExploreProperty> {
  constructor(props: ExploreProperty[]) {
    super("exploreDesc", props);
  }
}

export class FilterElement extends MalloyElement {
  elementType = "filterElement";
  constructor(readonly expr: ExpressionDef, readonly exprSrc: string) {
    super({ expr });
  }

  filterExpression(fs: FieldSpace): model.FilterExpression {
    const exprVal = this.expr.getExpression(fs);
    if (exprVal.dataType !== "boolean") {
      this.expr.log("Filter expression must have boolean value");
      return {
        source: this.exprSrc,
        expression: ["_FILTER_MUST_RETURN_BOOLEAN_"],
      };
    }
    const exprCond: model.FilterExpression = {
      source: this.exprSrc,
      expression: compressExpr(exprVal.value),
    };
    if (exprVal.aggregate) {
      exprCond.aggregate = true;
    }
    return exprCond;
  }
}

export class Filter extends ListOf<FilterElement> {
  elementType = "filter";
  private havingClause?: boolean;
  constructor(elements: FilterElement[] = []) {
    super("filterElements", elements);
  }

  set having(isHaving: boolean) {
    this.elementType = isHaving ? "having" : "where";
  }

  getFilterList(fs: FieldSpace): model.FilterExpression[] {
    const checked: model.FilterExpression[] = [];
    for (const oneElement of this.list) {
      const fExpr = oneElement.filterExpression(fs);
      // Aggregates are ALSO checked at SQL generation time, but checking
      // here allows better reflection of errors back to user.
      if (this.havingClause !== undefined) {
        if (this.havingClause) {
          if (!fExpr.aggregate) {
            oneElement.log("Aggregate expression expected in HAVING filter");
            continue;
          }
        } else {
          if (fExpr.aggregate) {
            oneElement.log("Aggregate expression not allowed in WHERE");
            continue;
          }
        }
      }
      checked.push(fExpr);
    }
    return checked;
  }
}

export class Measures extends ListOf<ExprFieldDecl> {
  constructor(measures: ExprFieldDecl[]) {
    super("measure", measures);
    for (const dim of measures) {
      dim.isMeasure = true;
    }
  }
}

export class Dimensions extends ListOf<ExprFieldDecl> {
  constructor(dimensions: ExprFieldDecl[]) {
    super("dimension", dimensions);
    for (const dim of dimensions) {
      dim.isMeasure = false;
    }
  }
}

export class FieldName
  extends MalloyElement
  implements FieldReferenceInterface
{
  elementType = "field name";

  constructor(readonly name: string) {
    super();
  }

  get refString(): string {
    return this.name;
  }
}

interface FieldReferenceInterface {
  refString: string;
}
export type FieldReference = FieldName | Wildcard;

export class FieldReferences extends ListOf<FieldReference> {
  constructor(members: FieldReference[]) {
    super("fieldReferenceList", members);
  }
}

export type FieldCollectionMember = FieldReference | ExprFieldDecl;
export function isFieldCollectionMember(
  el: MalloyElement
): el is FieldCollectionMember {
  return (
    el instanceof FieldName ||
    el instanceof Wildcard ||
    el instanceof ExprFieldDecl
  );
}
export class FieldCollection extends ListOf<FieldCollectionMember> {
  collectFor?: "project" | "index";
  constructor(members: FieldCollectionMember[]) {
    super("fieldCollection", members);
  }
}

export class FieldListEdit extends MalloyElement {
  elementType = "fieldListEdit";
  constructor(
    readonly edit: "accept" | "except",
    readonly refs: FieldReferences
  ) {
    super({ refs });
  }
}

export type QueryItem = ExprFieldDecl | FieldName;

export class GroupBy extends ListOf<QueryItem> {
  constructor(members: QueryItem[]) {
    super("groupBy", members);
  }
}

export class Aggregate extends ListOf<QueryItem> {
  constructor(members: QueryItem[]) {
    super("aggregate", members);
  }
}

interface SegmentDesc {
  segment: model.PipeSegment;
  computeShape: () => FieldSpace;
}
type SegType = "grouping" | "aggregate" | "project";

export class QueryDesc extends ListOf<QueryProperty> {
  segType: SegType = "grouping";
  private refineThis?: model.QuerySegment;
  constructor(props: QueryProperty[]) {
    super("queryDesc", props);
  }

  protected computeType(): SegType {
    let firstGuess: SegType | undefined;
    let anyGrouping = false;
    for (const el of this.list) {
      if (el instanceof GroupBy) {
        firstGuess ||= "grouping";
        anyGrouping = true;
        if (firstGuess === "project") {
          el.log("group_by: not legal in project: segment");
        }
      } else if (el instanceof Aggregate) {
        firstGuess ||= "aggregate";
        if (firstGuess === "project") {
          el.log("aggregate: not legal in project: segment");
        }
      } else if (el instanceof FieldCollection) {
        firstGuess ||= "project";
      }
    }
    if (firstGuess === "aggregate" && anyGrouping) {
      firstGuess = "grouping";
    }
    const guessType = firstGuess || "grouping";
    this.segType = guessType;
    return guessType;
  }

  protected getFieldSpace(inputFs: FieldSpace): QueryFieldSpace {
    switch (this.computeType()) {
      case "aggregate":
      case "grouping":
        return new ReduceFieldSpace(inputFs);
      case "project":
        return new ProjectFieldSpace(inputFs);
    }
  }

  refineFrom(existing: model.QuerySegment): void {
    this.refineThis = existing;
  }

  private getSegmentSpace(inputFs: FieldSpace): QueryFieldSpace {
    const pfs = this.getFieldSpace(inputFs);
    return pfs;
  }

  getSegmentDesc(inputFs: FieldSpace): SegmentDesc {
    const pfs = this.getSegmentSpace(inputFs);
    let didOrderBy: OrderBy | undefined;
    let didLimit: Limit | undefined;
    const segProp: Partial<model.QuerySegment> = { ...this.refineThis };
    if (segProp.fields) {
      delete segProp.fields;
    }
    for (const qp of this.list) {
      const errTo = qp;
      if (qp instanceof GroupBy || qp instanceof Aggregate) {
        pfs.addQueryItems(qp.list);
      } else if (qp instanceof Limit) {
        delete segProp.by;
        segProp.limit = qp.limit;
      } else if (qp instanceof Filter) {
        const newFilters = qp.getFilterList(pfs);
        if (segProp.filterList) {
          segProp.filterList.push(...newFilters);
        } else {
          segProp.filterList = newFilters;
        }
      } else if (qp instanceof Ordering) {
        delete segProp.by;
        segProp.orderBy = qp.list.map((o) => o.byElement());
      } else if (qp instanceof FieldCollection) {
        if (pfs instanceof ProjectFieldSpace) {
          pfs.addMembers(qp.list);
        } else {
          qp.log(`Not a legal statement in a ${this.segType} query`);
        }
      } else if (qp instanceof Top) {
        segProp.limit = qp.limit;
        if (didLimit) {
          didLimit.log("Ignored limit because top statement exists");
        }
        const topBy = qp.getBy(inputFs);
        if (topBy) {
          delete segProp.orderBy;
          segProp.by = topBy;
          if (didOrderBy) {
            didOrderBy.log("Ignored order_by becauase top_statement exists");
          }
        }
      } else if (qp instanceof Nests) {
        // TODO nest turtles in query segments
        qp.log("Can't nest a turtle in a query segement yet");
      } else {
        errTo.log(`Unrecognized segment parameter type`);
      }
    }
    const existingFields = this.refineThis?.fields;
    const seg = { ...pfs.querySegment(existingFields), ...segProp };
    return {
      segment: seg,
      computeShape: () =>
        new FieldSpace(
          ModelQuerySegment.nextStructDef(inputFs.structDef(), seg)
        ),
    };
  }
}

export interface ModelEntry {
  entry: model.NamedMalloyObject;
  exported?: boolean;
}
export interface NameSpace {
  getEntry(name: string): ModelEntry | undefined;
  setEntry(name: string, value: ModelEntry, exported: boolean): void;
}

export class Document extends MalloyElement implements NameSpace {
  elementType = "document";
  documentModel: Record<string, ModelEntry> = {};
  queryList: model.Query[] = [];
  constructor(readonly statements: DocStatement[]) {
    super({ statements });
  }

  getModelDef(extendingModelDef: model.ModelDef | undefined): model.ModelDef {
    this.documentModel = {};
    this.queryList = [];
    if (extendingModelDef) {
      for (const inName in extendingModelDef.structs) {
        const struct = extendingModelDef.structs[inName];
        if (struct.type == "struct") {
          const exported = extendingModelDef.exports.includes(inName);
          this.setEntry(inName, { entry: struct, exported });
        }
      }
    }
    for (const stmt of this.statements) {
      stmt.execute(this);
    }
    const def: model.ModelDef = { name: "", exports: [], structs: {} };
    for (const entry in this.documentModel) {
      if (this.documentModel[entry].exported) {
        def.exports.push(entry);
      }
      def.structs[entry] = cloneDeep(this.documentModel[entry].entry);
    }
    return def;
  }

  getEntry(str: string): ModelEntry {
    return this.documentModel[str];
  }

  setEntry(str: string, ent: ModelEntry): void {
    this.documentModel[str] = ent;
  }
}

export class PrimaryKey extends MalloyElement {
  elementType = "primary key";
  constructor(readonly field: FieldName) {
    super({ field });
  }
}

export class RenameField extends MalloyElement {
  elementType = "renameField";
  constructor(readonly newName: string, readonly oldName: string) {
    super();
  }
}

// I think this is left over, and in the new "everything is named" world
// this is not a class that needs to exist.
// export class NameOnly extends MalloyElement {
//   elementType = "nameOnly";
//   constructor(
//     readonly oldName: FieldName,
//     readonly filter: Filter,
//     readonly newName?: string
//   ) {
//     super({ oldName });
//   }

//   getFieldDef(_fs: FieldSpace): model.FieldDef {
//     throw new Error("REF/DUP fields not implemented yet");
//   }
// }

export class Wildcard extends MalloyElement implements FieldReferenceInterface {
  elementType = "wildcard";
  constructor(readonly joinName: string, readonly star: "*" | "**") {
    super();
  }

  getFieldDef(): model.FieldDef {
    throw this.internalError("fielddef request from wildcard reference");
  }

  get refString(): string {
    return this.joinName !== "" ? `${this.joinName}.${this.star}` : this.star;
  }
}

export class OrderBy extends MalloyElement {
  elementType = "orderBy";
  constructor(readonly field: number | string, readonly dir?: "asc" | "desc") {
    super();
  }

  byElement(): model.OrderBy {
    const orderElement: model.OrderBy = { field: this.field };
    if (this.dir) {
      orderElement.dir = this.dir;
    }
    return orderElement;
  }
}

export class Ordering extends ListOf<OrderBy> {
  constructor(list: OrderBy[]) {
    super("ordering", list);
  }

  orderBy(): model.OrderBy[] {
    return this.list.map((el) => el.byElement());
  }
}

export class Limit extends MalloyElement {
  elementType = "limit";
  constructor(readonly limit: number) {
    super();
  }
}

export class TurtleDecl extends MalloyElement implements DocStatement {
  elementType = "turtleDesc";
  constructor(readonly name: string, pipe: PipelineDesc) {
    super();
    this.has({ pipe });
  }

  execute(doc: Document): void {
    return;
  }
}

export class Turtles extends ListOf<TurtleDecl> implements DocStatement {
  constructor(turtles: TurtleDecl[]) {
    super("turtleDeclarationList", turtles);
  }

  execute(doc: Document): void {
    return;
  }
}

// export class Index extends Segment {
//   elementType = "index";
//   fields: IndexField[] = [];
//   filter?: Filter;
//   on?: FieldName;
//   limit?: number;

//   getPipeSegment(space: FieldSpace): model.IndexSegment {
//     const fieldNames: string[] = [];
//     for (const ref of this.fields) {
//       fieldNames.push(...ref.members.map((m) => m.text));
//     }
//     const indexDef: model.IndexSegment = {
//       type: "index",
//       fields: fieldNames,
//     };
//     if (this.limit) {
//       indexDef.limit = this.limit;
//     }
//     if (this.on) {
//       indexDef.weightMeasure = this.on.name;
//     }
//     if (this.filter) {
//       indexDef.filterList = this.filter.getFilterList(space);
//     }
//     return indexDef;
//   }
// }

/**
 * Generic abstract for all pipelines, the first segment might be a reference
 * to an existing pipeline (query or turtle), and if there is a refinement it
 * is refers to the first segment of the composed pipeline.
 *
 * I expect three subclasses for this. A query starting at an explore,
 * a query starting at a query, and a turtle definition.
 *
 * I aslo expect to re-factor once I have implemented all three of the
 * above and know enough to recognize the common elements.
 */
export class PipelineDesc extends MalloyElement {
  elementType = "pipelineDesc";
  private headRefinement?: QueryDesc;
  headName?: string;
  private segments: QueryDesc[] = [];

  refineHead(refinement: QueryDesc): void {
    this.headRefinement = refinement;
    this.has({ headRefinement: refinement });
  }

  addSegments(...segDesc: QueryDesc[]): void {
    this.segments.push(...segDesc);
    this.has({ segments: this.segments });
  }

  protected getPipelineForExplore(explore: Mallobj): model.Pipeline {
    throw new Error("NYI");
  }

  // TODO merge queryFromQuery and queryFromExplore ...
  getQueryFromQuery(): model.Query {
    if (!this.headName) {
      throw this.internalError("can't make query from nameless query");
    }
    const queryEntry = this.modelEntry(this.headName);
    const seedQuery = queryEntry?.entry;
    if (!seedQuery) {
      this.log(`Reference to undefined query '${this.headName}'`);
    } else if (seedQuery.type !== "query") {
      this.log(`Illegal eference to '${this.headName}', query expected`);
    } else {
      const result = { ...seedQuery };
      const explore = new QueryHeadStruct(result.structRef);
      const exploreFs = new FieldSpace(explore.structDef());
      if (this.headRefinement) {
        /*

          OK this where I stop on 12/31 ... the query head might be
          "exploreName -> turtleName" in which case I need to
          first copy the entire turtle into the pipeline and
          modify the first segment, which I already have code for
          below in queryFromExplore, and so now is the time to
          rationalize these two functions ... maybe, kind
          of want to write getPipelineForExplore() first though
          just to know for sure enough that I don't miss
          something

        */
        // rewrite existing pipe with refined first segment
        const firstSeg = result.pipeline[0];
        if (firstSeg.type === "index") {
          throw this.internalError("INDEX segment unexpected");
        }
        this.headRefinement.refineFrom(firstSeg);
        const newSeg = this.headRefinement.getSegmentDesc(exploreFs);
        const refinedPipe = [newSeg.segment, ...result.pipeline.slice(1)];
        result.pipeline = refinedPipe;
      }
      // Now walk the existing pipeline so we have the correct
      // inputspace for the new pipeline segments
      let walkStruct = explore.structDef();
      for (const modelQop of seedQuery.pipeline) {
        walkStruct = ModelQuerySegment.nextStructDef(walkStruct, modelQop);
      }
      let nextFs = function (): FieldSpace {
        return new FieldSpace(walkStruct);
      };
      for (const qop of this.segments) {
        const next = qop.getSegmentDesc(nextFs());
        result.pipeline.push(next.segment);
        nextFs = next.computeShape;
      }
      return result;
    }
    return ErrorFactory.query();
  }

  getQueryFromExplore(explore: Mallobj): model.Query {
    const type = "query";
    const structRef = explore.structRef();
    const structDef = model.refIsStructDef(structRef)
      ? structRef
      : explore.structDef();
    const pipeline: model.PipeSegment[] = [];
    let pipeFs = new FieldSpace(structDef);
    if (this.headName) {
      const turtle = getStructFieldDef(structDef, this.headName);
      if (!turtle) {
        this.log(`Reference to undefined explore query '${this.headName}'`);
      } else if (turtle.type !== "turtle") {
        this.log(`'${this.headName}' is not a query`);
      } else {
        // Copy the full turtle pipeline ...
        // TODO there is an issue with losing the name of the turtle
        // which we need to fix, possibly adding a "name:" field to a segment
        pipeline.push(...turtle.pipeline);

        // Refine the first segment if needed
        const firstSeg = pipeline[0];
        if (this.headRefinement && firstSeg) {
          if (firstSeg.type === "index") {
            // TODO delete index segments from the world, and then this error
            throw new Error("Index segments no longer supported");
          }
          this.headRefinement.refineFrom(firstSeg);
          // TODO push refinement filters into the query .. question mark?
          const newHead = this.headRefinement.getSegmentDesc(pipeFs);
          pipeline[0] = newHead.segment;
        }

        // Now, walk the pipeline so we know the shape at the end ...
        let pipeStruct = structDef;
        for (const querySeg of pipeline) {
          pipeStruct = ModelQuerySegment.nextStructDef(pipeStruct, querySeg);
        }
        pipeFs = new FieldSpace(pipeStruct);
      }
    }
    // Walk the pipeline, translating each stage based on the output shape
    // of the previous stage.
    let next: SegmentDesc | undefined;
    for (const nextSegDesc of this.segments) {
      if (next) {
        pipeFs = next.computeShape();
      }
      next = nextSegDesc.getSegmentDesc(pipeFs);
      pipeline.push(next.segment);
    }
    return { type, structRef, pipeline };
  }
}

/**
 * A FullQuery is something which starts at an explorable, and then
 * may have a named-turtle first segment, which may have refinments,
 * and then it has a pipeline of zero or more segments after that.
 */
export class FullQuery extends MalloyElement {
  elementType = "fullQuery";

  constructor(readonly explore: Mallobj, readonly pipeline: PipelineDesc) {
    super({ explore, pipeline });
  }

  query(): model.Query {
    return this.pipeline.getQueryFromExplore(this.explore);
  }
}

export class ExistingQuery extends MalloyElement {
  elementType = "queryFromQuery";
  constructor(readonly queryDesc: PipelineDesc) {
    super();
    this.has({ queryDesc });
  }

  query(): model.Query {
    return this.queryDesc.getQueryFromQuery();
  }
}

export function canBeQuery(e: MalloyElement): e is FullQuery | ExistingQuery {
  return e instanceof FullQuery || e instanceof ExistingQuery;
}

export class DefineQuery extends MalloyElement implements DocStatement {
  elementType = "defineQuery";

  constructor(
    readonly name: string,
    readonly queryDetails: FullQuery | ExistingQuery
  ) {
    super({ queryDetails });
  }

  execute(doc: Document): void {
    doc.setEntry(this.name, {
      entry: this.queryDetails.query(),
      exported: false, // TODO make them exportable
    });
  }
}



interface TopByExpr {
  byExpr: ExpressionDef;
}
type TopInit = { byString: string } | TopByExpr;
function isByExpr(t: TopInit): t is TopByExpr {
  return (t as TopByExpr).byExpr !== undefined;
}

export class Top extends MalloyElement {
  elementType = "top";
  constructor(readonly limit: number, readonly by?: TopInit) {
    super();
    this.has({ byExpression: (by as TopByExpr)?.byExpr });
  }

  getBy(fs: FieldSpace): model.By | undefined {
    if (this.by) {
      if (isByExpr(this.by)) {
        const byExpr = this.by.byExpr.getExpression(fs);
        if (!byExpr.aggregate) {
          this.log("top by expression must be an aggregate");
        }
        return { by: "expression", e: compressExpr(byExpr.value) };
      }
      return { by: "name", name: this.by.byString };
    }
    return undefined;
  }
}

export class JSONElement extends MalloyElement {
  elementType = "jsonElement";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly value: any;
  constructor(jsonSrc: string) {
    super();
    try {
      this.value = JSON.parse(jsonSrc);
    } catch (SyntaxError) {
      this.log("JSON syntax error");
      this.value = undefined;
    }
  }
}

export class JSONStructDef extends Mallobj {
  elementType = "jsonStructDef";
  constructor(readonly struct: model.StructDef) {
    super();
  }

  static fromJSON(jsonObj: JSONElement): JSONStructDef | undefined {
    const obj = jsonObj.value;
    if (
      obj &&
      obj.type === "struct" &&
      obj.structRelationship &&
      obj.structSource
    ) {
      return new JSONStructDef(obj as model.StructDef);
    }
    return undefined;
  }

  structDef(): model.StructDef {
    return this.struct;
  }
}

export class ImportStatement extends MalloyElement implements DocStatement {
  elementType = "import statement";
  fullURL?: string;

  /*
   * At the time of writng this comment, it is guaranteed that if an AST
   * node for an import statement is created, the translator has already
   * succesfully fetched the URL referred to in the statement.
   *
   * Error checking code in here is future proofing against a day when
   * there are other ways to contruct an AST.
   */

  constructor(readonly url: string, baseURL: string) {
    super();
    try {
      this.fullURL = new URL(url, baseURL).toString();
    } catch (e) {
      this.log("Invalid URI in import statement");
    }
  }

  execute(doc: Document): void {
    const trans = this.translator();
    if (!trans) {
      this.log("Cannot import without translation context");
    } else if (this.fullURL) {
      const src = trans.root.importZone.getEntry(this.fullURL);
      if (src.status === "present") {
        const importStructs = trans.getChildExports(this.fullURL);
        for (const importing in importStructs) {
          doc.setEntry(importing, {
            entry: importStructs[importing],
            exported: false,
          });
        }
      } else if (src.status === "error") {
        this.log(`import failed: '${src.message}'`);
      } else {
        this.log(`import failed with status: '${src.status}'`);
      }
    }
  }
}

export class DocumentQuery extends MalloyElement implements DocStatement {
  elementType = "document query";
  constructor(readonly explore: Explore, readonly index: number) {
    super({ explore });
  }

  execute(doc: Document): void {
    doc.queryList[this.index] = this.explore.query();
  }
}

interface HasInit {
  name: string;
  isCondition: boolean;
  type?: string;
  default?: ConstantSubExpression;
}

export class HasParameter extends MalloyElement {
  elementType = "hasParameter";
  readonly name: string;
  readonly isCondition: boolean;
  readonly type?: model.AtomicFieldType;
  readonly default?: ConstantSubExpression;

  constructor(init: HasInit) {
    super();
    this.name = init.name;
    this.isCondition = init.isCondition;
    if (init.type && model.isAtomicFieldType(init.type)) {
      this.type = init.type;
    }
    if (init.default) {
      this.default = init.default;
      this.has({ default: this.default });
    }
  }

  parameter(): model.Parameter {
    const name = this.name;
    const type = this.type || "string";
    if (this.isCondition) {
      const cCond = this.default?.constantCondition(type).value || null;
      return {
        type,
        name,
        condition: cCond,
      };
    }
    const cVal = this.default?.constantValue().value || null;
    return {
      value: cVal,
      type,
      name: this.name,
      constant: false,
    };
  }
}

export class ConstantParameter extends HasParameter {
  constructor(name: string, readonly value: ConstantSubExpression) {
    super({ name, isCondition: false });
    this.has({ value });
  }

  parameter(): model.Parameter {
    const cVal = this.value.constantValue();
    if (!model.isAtomicFieldType(cVal.dataType)) {
      this.log(`Unexpected expression type '${cVal.dataType}'`);
      return {
        value: ["XXX-type-mismatch-error-XXX"],
        type: "string",
        name: this.name,
        constant: true,
      };
    }
    return {
      value: cVal.value,
      type: cVal.dataType,
      name: this.name,
      constant: true,
    };
  }
}
