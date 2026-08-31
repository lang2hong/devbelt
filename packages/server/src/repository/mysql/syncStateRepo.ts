import type { ISyncStateRepo } from '../interfaces.js';
import type {
  PersonalSyncState,
  SmpKdf,
  RecoveryKdf,
} from '../../domain/entities.js';
import type { MysqlDb, Queryable } from './db.js';

const COLS = [
  'user_id', 'key_epoch', 'state_version', 'change_sequence',
  'protocol_version', 'cipher_suite', 'format_version',
  'smp_kdf_json', 'recovery_kdf_json',
  'envelope_smp_version', 'envelope_smp_nonce', 'envelope_smp_ct', 'envelope_smp_tag',
  'envelope_recovery_version', 'envelope_recovery_nonce', 'envelope_recovery_ct', 'envelope_recovery_tag',
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
    s.signPub, s.recoverSignPub, s.recoveryCodeSetTime,
  ];
}

function mapState(r: any): PersonalSyncState {
  const smp = typeof r.smp_kdf_json === 'string' ? JSON.parse(r.smp_kdf_json) : r.smp_kdf_json;
  const rec = typeof r.recovery_kdf_json === 'string' ? JSON.parse(r.recovery_kdf_json) : r.recovery_kdf_json;
  return {
    userId: r.user_id,
    keyEpoch: r.key_epoch,
    stateVersion: r.state_version,
    changeSequence: r.change_sequence,
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
    envelopeSmp: { version: r.envelope_smp_version, nonce: r.envelope_smp_nonce, ct: r.envelope_smp_ct, tag: r.envelope_smp_tag },
    envelopeRecovery: { version: r.envelope_recovery_version, nonce: r.envelope_recovery_nonce, ct: r.envelope_recovery_ct, tag: r.envelope_recovery_tag },
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
    const [rows] = await this.db().query<any[]>('SELECT * FROM personal_sync_state WHERE user_id = ?', [userId]);
    return rows[0] ? mapState(rows[0]) : undefined;
  }

  async lockByUserId(exec: Queryable, userId: number): Promise<PersonalSyncState | undefined> {
    const [rows] = await exec.query<any[]>('SELECT * FROM personal_sync_state WHERE user_id = ? FOR UPDATE', [userId]);
    return rows[0] ? mapState(rows[0]) : undefined;
  }

  async create(exec: Queryable, state: StateInput): Promise<boolean> {
    try {
      await exec.query<any>(
        `INSERT INTO personal_sync_state (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params(state),
      );
      return true;
    } catch (err: any) {
      // PK 冲突（user_id 已有 state）→ init 竞态，返回 false 对应 409 SYNC_STATE_EXISTS。
      if (err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062) return false;
      throw err;
    }
  }

  async update(exec: Queryable, userId: number, expectedStateVersion: number, state: StateInput): Promise<boolean> {
    const [result] = await exec.query<any>(
      `UPDATE personal_sync_state
       SET key_epoch = ?, state_version = ?, change_sequence = ?,
           protocol_version = ?, cipher_suite = ?, format_version = ?,
           smp_kdf_json = ?, recovery_kdf_json = ?,
           envelope_smp_version = ?, envelope_smp_nonce = ?, envelope_smp_ct = ?, envelope_smp_tag = ?,
           envelope_recovery_version = ?, envelope_recovery_nonce = ?, envelope_recovery_ct = ?, envelope_recovery_tag = ?,
           sign_pub = ?, recover_sign_pub = ?, recovery_code_set_time = ?
       WHERE user_id = ? AND state_version = ?`,
      [
        state.keyEpoch, state.stateVersion, state.changeSequence,
        state.protocolVersion, state.cipherSuite, state.formatVersion,
        JSON.stringify(serializeSmpKdf(state.smpKdf)),
        JSON.stringify(serializeRecoveryKdf(state.recoveryKdf)),
        state.envelopeSmp.version, state.envelopeSmp.nonce, state.envelopeSmp.ct, state.envelopeSmp.tag,
        state.envelopeRecovery.version, state.envelopeRecovery.nonce, state.envelopeRecovery.ct, state.envelopeRecovery.tag,
        state.signPub, state.recoverSignPub, state.recoveryCodeSetTime,
        userId, expectedStateVersion,
      ],
    );
    return Number(result.affectedRows) === 1;
  }
}