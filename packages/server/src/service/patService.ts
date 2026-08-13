import { randomBytes, createHash } from 'crypto';
import type { IPatRepo, IUserRepo } from '../repository/interfaces.js';
import type { PlanPolicy } from '../policy/planPolicy.js';
import type { Pat } from '../domain/entities.js';
import { EntityNotFoundError } from '../domain/errors.js';

export type PatInfo = Omit<Pat, 'tokenHash'>;

export interface PatCreateResult {
  pat: PatInfo;
  token: string;  // 明文 token，仅创建时返回一次
}

/**
 * PAT 服务：个人访问令牌增删查。
 * 配额：max_pats（plan 限制）；token 明文不存库，仅存 sha256 hash。
 */
export class PatService {
  constructor(
    private readonly patRepo: IPatRepo,
    private readonly userRepo: IUserRepo,
    private readonly planPolicy: PlanPolicy,
  ) {}

  async create(userId: number, name: string, scopes: string): Promise<PatCreateResult> {
    const user = await this.userRepo.findById(userId);
    if (!user) throw new EntityNotFoundError('user', userId);
    const count = await this.patRepo.countActiveForUser(userId);
    await this.planPolicy.check(user.planCode, 'pats', count);

    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const pat = await this.patRepo.create({ userId, name, tokenHash, scopes });
    return { pat: sanitize(pat), token };
  }

  async list(userId: number): Promise<PatInfo[]> {
    const list = await this.patRepo.listByUser(userId);
    return list.map(sanitize);
  }

  async revoke(userId: number, id: number): Promise<void> {
    const pat = await this.patRepo.findById(id);
    if (!pat || pat.userId !== userId) throw new EntityNotFoundError('pat', id);
    await this.patRepo.revoke(id);
  }
}

function sanitize(pat: Pat): PatInfo {
  const { tokenHash, ...rest } = pat;
  return rest;
}
