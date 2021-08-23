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

// temporary interface to Malloy - this will change once we have
// better handle on concepts/names
import { BigQuery } from "./db/bigquery";
import {
  CompiledQuery,
  ModelDef,
  Query,
  QueryData,
  QueryModel,
  QueryResult,
} from "./model";

export interface Loggable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug: (message?: any, ...optionalParams: any[]) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  info: (message?: any, ...optionalParams: any[]) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  warn: (message?: any, ...optionalParams: any[]) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error: (message?: any, ...optionalParams: any[]) => void;
}

export class Malloy {
  // TODO load from file built during release
  public static get version(): string {
    return "0.0.1";
  }

  private static _db: BigQuery | undefined;
  private static _log: Loggable;

  public static get db(): BigQuery {
    // TODO we may not want to do this by default but makes testing etc work for now. We'd prefer to always
    // require that you set this up intentionally
    return Malloy._db ? Malloy._db : new BigQuery();
  }

  public static get log(): Loggable {
    return Malloy._log || console;
  }

  private queryModel: QueryModel;

  constructor() {
    this.queryModel = new QueryModel(undefined);
  }

  public static setLogger(log: Loggable): void {
    Malloy._log = log;
  }

  public static setDB(bq: BigQuery): void {
    Malloy._db = bq;
  }

  public async parseAndLoadModel(model: string): Promise<void> {
    await this.queryModel.parseModel(model);
  }

  public get model(): ModelDef | undefined {
    return this.queryModel.modelDef;
  }

  public set model(modelDef: ModelDef | undefined) {
    if (modelDef) {
      this.queryModel.loadModelFromDef(modelDef);
    } else {
      this.queryModel.modelDef = undefined;
    }
  }

  public async runQuery(
    query: string,
    pageSize?: number,
    rowIndex?: number
  ): Promise<QueryResult> {
    return this.queryModel.runQuery(query, pageSize, rowIndex);
  }

  public async runCompiledQuery(
    query: CompiledQuery,
    pageSize?: number,
    rowIndex?: number
  ): Promise<QueryResult> {
    return this.queryModel.runCompiledQuery(query, pageSize, rowIndex);
  }

  public async compileQuery(query: Query | string): Promise<CompiledQuery> {
    return await this.queryModel.compileQuery(query);
  }

  public async computeSql(query: string): Promise<string> {
    return (await this.compileQuery(query)).sql;
  }

  async searchIndex(explore: string, searchValue: string): Promise<QueryData> {
    return this.queryModel.searchIndex(explore, searchValue);
  }
}