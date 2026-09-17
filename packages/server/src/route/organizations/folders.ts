import type { FastifyInstance } from 'fastify';
import { sendError } from '../../middleware/errorHandler.js';
import { createFolderBody, folderIdParam, organizationIdParam, updateFolderBody } from '../schemas.js';
import { toFolderDto } from './dto.js';
import type { OrgRoutesContext } from './context.js';

/** 目录：列表 / 创建 / 改名移动 / 删除（folder.read / folder.manage）。 */
export async function registerFolderRoutes(org: FastifyInstance, ctx: OrgRoutesContext): Promise<void> {
  const { resources } = ctx;

  org.get('/api/db/organizations/:organizationId/folders', { config: { permission: 'folder.read' }, schema: { params: organizationIdParam } }, async (req, reply) => {
    const organizationId = (req as any).authOrganizationId as number;
    try {
      const list = await resources.listFolders(organizationId);
      reply.send({ folders: list.map(toFolderDto) });
    } catch (e) {
      sendError(reply, e);
    }
  });

  org.post('/api/db/organizations/:organizationId/folders', { config: { permission: 'folder.manage', aud: 'extension' }, schema: { params: organizationIdParam, body: createFolderBody } }, async (req, reply) => {
    const organizationId = (req as any).authOrganizationId as number;
    const actorUserId = (req as any).authUserId as number;
    const body = req.body as any;
    try {
      const folder = await resources.createFolder(organizationId, actorUserId, body.name, body.parentId === null ? null : body.parentId ? Number(body.parentId) : undefined);
      reply.code(201).send({ folder: toFolderDto(folder) });
    } catch (e) {
      sendError(reply, e);
    }
  });

  org.patch('/api/db/organizations/:organizationId/folders/:folderId', { config: { permission: 'folder.manage', aud: 'extension' }, schema: { params: folderIdParam, body: updateFolderBody } }, async (req, reply) => {
    const organizationId = (req as any).authOrganizationId as number;
    const actorUserId = (req as any).authUserId as number;
    const folderId = Number((req.params as any).folderId);
    const body = req.body as any;
    const parentId = body.parentId === null ? null : body.parentId !== undefined ? Number(body.parentId) : undefined;
    try {
      const folder = await resources.updateFolder(organizationId, actorUserId, folderId, { name: body.name, parentId });
      reply.send({ folder: toFolderDto(folder) });
    } catch (e) {
      sendError(reply, e);
    }
  });

  org.delete('/api/db/organizations/:organizationId/folders/:folderId', { config: { permission: 'folder.manage', aud: 'extension' }, schema: { params: folderIdParam } }, async (req, reply) => {
    const organizationId = (req as any).authOrganizationId as number;
    const actorUserId = (req as any).authUserId as number;
    const folderId = Number((req.params as any).folderId);
    try {
      const r = await resources.deleteFolder(organizationId, actorUserId, folderId);
      reply.send(r);
    } catch (e) {
      sendError(reply, e);
    }
  });
}