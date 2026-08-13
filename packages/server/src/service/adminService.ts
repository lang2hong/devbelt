import type { IUserRepo } from '../repository/interfaces.js';
import type { User } from '../domain/entities.js';
import type { Role, PlanCode, UserStatus } from '../domain/enums.js';

export type UserInfo = Omit<User, 'passwordHash'>;

export interface UpdateUserInput {
  role?: Role;
  planCode?: PlanCode;
  status?: UserStatus;
}

/**
 * 管理员服务：用户管理（RBAC admin 专用）。
 * route/admin.ts 通过此服务操作用户，不直接访问 repo。
 */
export class AdminService {
  constructor(private readonly userRepo: IUserRepo) {}

  async listUsers(limit: number, offset: number): Promise<UserInfo[]> {
    const users = await this.userRepo.listAll(limit, offset);
    return users.map(sanitize);
  }

  async updateUser(id: number, input: UpdateUserInput): Promise<void> {
    if (input.role) await this.userRepo.updateRole(id, input.role);
    if (input.planCode) await this.userRepo.updatePlan(id, input.planCode);
    if (input.status) await this.userRepo.updateStatus(id, input.status);
  }
}

function sanitize(user: User): UserInfo {
  const { passwordHash, ...rest } = user;
  return rest;
}
