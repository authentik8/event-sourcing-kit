import debugModule from 'debug';

import fs from 'async-file';
import { injectable } from 'inversify';
import { dirname } from 'path';

import { AppendOnlyStoreConcurrencyError } from './errors';
import {
  IAppendOnlyStore,
  IFileStoreConfig,
  IStreamData,
  StreamDataPredicate
} from './interfaces';

const debug = debugModule('eskit:eventstore:FileStorage');

const matchesStream = (streamId: string) => (record: IStreamData) =>
  record.streamId === streamId;
const afterVersion = (after: number) => (record: IStreamData) =>
  record.version > after;

@injectable()
export class FileStore implements IAppendOnlyStore {
  private readonly _config: IFileStoreConfig;
  private _nextId?: number;

  constructor(config: IFileStoreConfig) {
    this._config = config;
    debug(`Initialise FileStore using "${config.filepath}"`);
  }

  public async append(streamId: string, data: object[], version: number) {
    await this._ensureExists();
    await this._checkVersion(streamId, version);

    await this._ensureNextId();

    const records = data.map(this._createRecord({ streamId, offset: version }));

    const encoded = this._encode(records);
    await fs.appendFile(this._config.filepath, encoded, {
      encoding: 'utf8',
      flag: 'a+'
    });

    return records;
  }

  public async readAllRecords(skip: number = 0, limit?: number) {
    debug(`Load all records`);
    const allRecords = await this._readFileContents();
    debug(`Loaded ${allRecords.length} records`);

    debug(`Reading ${limit || 'all'} records starting at ${skip || 0}`);
    return allRecords.slice(skip).slice(0, limit);
  }

  public async readAllRecordsInRange({
    afterTs,
    beforeTs
  }: {
    afterTs?: number;
    beforeTs?: number;
  }) {
    /*
     * TODO: Refactor implementation as this is inefficient, particularly with
     * large event stores
     */
    debug(`Load all records`);
    const allRecords = await this._readFileContents();
    debug(`Loaded ${allRecords.length} records`);

    debug(
      `Filtering for records after ${afterTs ||
        'beginning of time'} & before ${beforeTs || 'end of time'}`
    );

    // Predicate function checking `before` condition if defined
    const pBefore: StreamDataPredicate = e =>
      beforeTs === undefined || e.timestamp < beforeTs;

    // Predicate function checking `after` condition if defined
    const pAfter: StreamDataPredicate = e =>
      afterTs === undefined || e.timestamp > afterTs;

    return allRecords.filter(record => pBefore(record) && pAfter(record));
  }

  public async readRecords(streamId: string, after?: number, limit?: number) {
    const allRecords = await this.readAllRecords();
    const records = allRecords
      .filter(matchesStream(streamId))
      .filter(afterVersion(after || 0));

    return records.slice(0, limit);
  }

  private async _getVersion(streamId: string): Promise<number> {
    const events = await this.readRecords(streamId);
    return (events && events.length && events[events.length - 1].version) || 0;
  }

  private async _checkVersion(
    streamId: string,
    version: number
  ): Promise<void> {
    const savedVersion = await this._getVersion(streamId);
    if (savedVersion !== version) {
      throw new AppendOnlyStoreConcurrencyError(
        streamId,
        version,
        savedVersion
      );
    }
  }

  private async _ensureExists(): Promise<void> {
    const dir = dirname(this._config.filepath);
    let dirExists = await fs.exists(dir);

    if (!dirExists) {
      try {
        await fs.createDirectory(dir);
      } catch {
        dirExists = true;
      }
    }
    await fs.writeTextFile(this._config.filepath, '', 'utf8', 'a');
  }

  private async _readFileContents(): Promise<IStreamData[]> {
    await this._ensureExists();
    debug(`Read contents of ${this._config.filepath}`);
    const fileContents = await fs.readTextFile(
      this._config.filepath,
      'utf8',
      'r'
    );

    const lines = fileContents.split('\n');
    debug(
      `Loaded contents of file ${this._config.filepath} (${lines.length} lines)`
    );

    return lines.filter(s => s.length > 0).map(this._parseRecord);
  }

  private _createRecord = ({
    offset,
    streamId
  }: {
    offset: number;
    streamId: string;
  }) => (data: object, index: number) => ({
    data,
    streamId,
    id: this._nextId!++,
    timestamp: new Date().getTime(),
    version: offset + index + 1
  });

  private _parseRecord(encoded: string): IStreamData {
    return JSON.parse(encoded) as IStreamData;
  }

  private _encode(records: IStreamData[]): string {
    return records.map(r => JSON.stringify(r) + '\n').join('');
  }

  private async _ensureNextId(): Promise<void> {
    if (!this._nextId) {
      const records = await this.readAllRecords();
      this._nextId =
        (records && records.length && records[records.length - 1].id + 1) || 1;
    }
  }
}
