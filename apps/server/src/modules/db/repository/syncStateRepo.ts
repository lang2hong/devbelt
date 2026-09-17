import type { ISyncStateRepo } from '../../../repository/interfaces.js';
import type {
  PersonalSyncState,
  SmpKdf,
  RecoveryKdf,
} from '../../../domain/entities.js';
import type { MysqlDb, Queryable } from '../../../repository/mysql/db.js';

// u64 协议字段（key_epoch/state_version/change_sequence/envelope versions）在 SQL 层
// CAST AS CHAR 返回十进制字符串，避免 mysql2 默认 number 的 2^53 精度丢失（§7.1）。
const SELECT_COLS = `
  user_id,
  CAST(key_epoch AS CHAR) AS key_epoch,
  CAST(state_version AS CHAR) AS state_version,
  CAST(change_sequence AS CHAR) AS change_sequence,
  protocol_version, cipher_suite, format_version,
  smp_kdf_json, recovery_kdf_json,
  CAST(envelope_smp_version AS CHAR) AS envelope_smp_version,
  envelope_smp_nonce, envelope_smp_ct, envelope_smp_tag,
  CAST(envelope_recovery_version AS CHAR) AS envelope_recovery_version,
  envelope_recovery_nonce, envelope_recovery_ct, envelope_recovery_tag,
  CAST(envelope_account_version AS CHAR) AS envelope_account_version,
  envelope_account_nonce, envelope_account_ct, envelope_account_tag,
  account_recovery_key,
  sign_pub, recover_sign_pub, recovery_code_set_time,
  create_time, update_time
`;

const INSERT_COLS = [
  'user_id', 'key_epoch', 'state_version', 'change_sequence',
  'protocol_version', 'cipher_suite', 'format_version',
  'smp_kdf_json', 'recovery_kdf_json',
  'envelope_smp_version', 'envelope_smp_nonce', 'envelope_smp_ct', 'envelope_smp_tag',
  'envelope_recovery_version', 'envelope_recovery_nonce', 'envelope_recovery_ct', 'envelope_recovery_tag',
  'envelope_account_version', 'envelope_account_nonce', 'envelope_account_ct', 'envelope_account_tag',
  'account_recovery_key',
  'sign_pub', 'recover_sign_pub', 'recovery_code_set_time',
].join(', ');

type StateInput = Omit<PersonalSyncState, 'createTime' | 'updateTime'>;

function serializeSmpKdf(k: SmpKdf): Record<string, unknown> {
  return {
    alg: k.alg, version: 1, memoryKiB: k.memoryKiB, iterations: k.iterations,
    parallelism: k.parallelism, salt: k.salt.toString('base64url'), outputBytes: 32,
  };
}

function serializeRecoveryKdf(k: RecoveryKdf): Record<string, unknown> {
  return { alg: k.alg, version: 1, salt: k.salt.toString('base64url'), outputBytes: 32 };
}

function params(s: StateInput): unknown[] {
  return [
    s.userId, s.keyEpoch, s.stateVersion, s.changeSequence,
    s.protocolVersion, s.cipherSuite, s.formatVersion,
    JSON.stringify(serializeSmpKdf(s.smpKdf)),
    JSON.stringify(serializeRecoveryKdf(s.recoveryKdf)),
    s.envelopeSmp.version, s.envelopeSmp.nonce, s.envelopeSmp.ct, s.envelopeSmp.tag,
    s.envelopeRecovery.version, s.envelopeRecovery.nonce, s.envelopeRecovery.ct, s.envelopeRecovery.tag,
    s.envelopeAccount.version, s.envelopeAccount.nonce, s.envelopeAccount.ct, s.envelopeAccount.tag,
    s.accountRecoveryKey,
    s.signPub, s.recoverSignPub, s.recoveryCodeSetTime,
  ];
}

function mapState(r: any): PersonalSyncState {
  const smp = typeof r.smp_kdf_json === 'string' ? JSON.parse(r.smp_kdf_json) : r.smp_kdf_json;
  const rec = typeof r.recovery_kdf_json === 'string' ? JSON.parse(r.recovery_kdf_json) : r.recovery_kdf_json;
  return {
    userId: r.user_id,
    keyEpoch: String(r.key_epoch),
    stateVersion: String(r.state_version),
    changeSequence: String(r.change_sequence),
    protocolVersion: r.protocol_version,
    cipherSuite: r.cipher_suite,
    formatVersion: r.format_version,
    smpKdf: {
      alg: 'argon2id', version: 1, memoryKiB: smp.memoryKiB, iterations: smp.iterations,
      parallelism: smp.parallelism, salt: Buffer.from(smp.salt, 'base64url'), outputBytes: 32,
    },
    recoveryKdf: {
      alg: 'hkdf-sha256', version: 1, salt: Buffer.from(rec.salt, 'base64url'), outputBytes: 32,
    },
    envelopeSmp: { version: String(r.envelope_smp_version), nonce: r.envelope_smp_nonce, ct: r.envelope_smp_ct, tag: r.envelope_smp_tag },
    envelopeRecovery: { version: String(r.envelope_recovery_version), nonce: r.envelope_recovery_nonce, ct: r.envelope_recovery_ct, tag: r.envelope_recovery_tag },
    envelopeAccount: { version: String(r.envelope_account_version), nonce: r.envelope_account_nonce, ct: r.envelope_account_ct, tag: r.envelope_account_tag },
    accountRecoveryKey: r.account_recovery_key,
    signPub: r.sign_pub,
    recoverSignPub: r.recover_sign_pub,
    recoveryCodeSetTime: r.recovery_code_set_time ? new Date(r.recovery_code_set_time) : null,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}

export class MysqlSyncStateRepo implements ISyncStateRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async findByUserId(userId: number): Promise<PersonalSyncState | undefined> {
    const [rows] = await this.db().query<any[]>(`SELECT ${SELECT_COLS} FROM personal_sync_state WHERE user_id = ?`, [userId]);
    return rows[0] ? mapState(rows[0]) : undefined;
  }

  async lockByUserId(exec: Queryable, userId: number): Promise<PersonalSyncState | undefined> {
    const [rows] = await exec.query<any[]>(`SELECT ${SELECT_COLS} FROM personal_sync_state WHERE user_id = ? FOR UPDATE`, [userId]);
    return rows[0] ? mapState(rows[0]) : undefined;
  }

  async create(exec: Queryable, state: StateInput): Promise<boolean> {
    try {
      await exec.query<any>(
        `INSERT INTO personal_sync_state (${INSERT_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params(state),
      );
      return true;
    } catch (err: any) {
      if (err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062) return false;
      throw err;
    }
  }

  async update(exec: Queryable, userId: number, expectedStateVersion: string, state: StateInput): Promise<boolean> {
    const [result] = await exec.query<any>(
      `UPDATE personal_sync_state
       SET key_epoch = ?, state_version = ?, change_sequence = ?,
           protocol_version = ?, cipher_suite = ?, format_version = ?,
           smp_kdf_json = ?, recovery_kdf_json = ?,
           envelope_smp_version = ?, envelope_smp_nonce = ?, envelope_smp_ct = ?, envelope_smp_tag = ?,
           envelope_recovery_version = ?, envelope_recovery_nonce = ?, envelope_recovery_ct = ?, envelope_recovery_tag = ?,
           envelope_account_version = ?, envelope_account_nonce = ?, envelope_account_ct = ?, envelope_account_tag = ?,
           account_recovery_key = ?,
           sign_pub = ?, recover_sign_pub = ?, recovery_code_set_time = ?
       WHERE user_id = ? AND state_version = ?`,
      [
        state.keyEpoch, state.stateVersion, state.changeSequence,
        state.protocolVersion, state.cipherSuite, state.formatVersion,
        JSON.stringify(serializeSmpKdf(state.smpKdf)),
        JSON.stringify(serializeRecoveryKdf(state.recoveryKdf)),
        state.envelopeSmp.version, state.envelopeSmp.nonce, state.envelopeSmp.ct, state.envelopeSmp.tag,
        state.envelopeRecovery.version, state.envelopeRecovery.nonce, state.envelopeRecovery.ct, state.envelopeRecovery.tag,
        state.envelopeAccount.version, state.envelopeAccount.nonce, state.envelopeAccount.ct, state.envelopeAccount.tag,
        state.accountRecoveryKey,
        state.signPub, state.recoverSignPub, state.recoveryCodeSetTime,
        userId, expectedStateVersion,
      ],
    );
    return Number(result.affectedRows) === 1;
  }
}