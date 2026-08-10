import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BlogArticleFormat } from '@prisma/client';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateBlogArticleItemDto {
  position?: number;
  appleId?: string;
  type?: string;
  title: string;
  artistName: string;
  artworkUrl?: string;
  streamCount?: number;
  countryCount?: number;
  sectionTitleEn?: string;
  sectionTextEn?: string;
}

export interface CreateBlogArticleDto {
  format?: BlogArticleFormat;
  appleId?: string;
  type?: string;
  title?: string;
  titleEn?: string;
  artistName?: string;
  artworkUrl?: string;
  streamCount?: number;
  countryCount?: number;
  weekOf?: string;
  editorialEn?: string;
  introEn?: string;
  conclusionEn?: string;
  items?: CreateBlogArticleItemDto[];
  published?: boolean;
}

/** Longueur de l'extrait servi dans la liste, coupe sur un mot entier. */
const EXCERPT_LENGTH = 260;

@Injectable()
export class BlogService {
  private readonly logger = new Logger(BlogService.name);

  constructor(private prisma: PrismaService) {}

  private serialize(a: any) {
    if (!a) return a;
    const items = a.items?.length
      ? a.items
      : [{
          id: -a.id,
          articleId: a.id,
          position: 1,
          appleId: a.appleId,
          type: a.type,
          title: a.title,
          artistName: a.artistName,
          artworkUrl: a.artworkUrl,
          streamCount: a.streamCount,
          countryCount: a.countryCount,
          sectionTitleEn: null,
          sectionTextEn: null,
        }];
    return {
      ...a,
      streamCount: a.streamCount !== null ? Number(a.streamCount) : null,
      items: items.map((item: any) => ({
        ...item,
        streamCount: item.streamCount !== null ? Number(item.streamCount) : null,
      })),
    };
  }

  private wordCount(text?: string | null): number {
    return (text ?? '').trim().split(/\s+/).filter(Boolean).length;
  }

  /**
   * Nombre de mots reellement rendus sur la page article. Calcule ici pour que
   * la liste puisse s'en servir (seuil d'indexation, sitemap) sans transporter
   * le texte integral de chaque article.
   */
  private articleWordCount(a: any): number {
    const structured = [a.introEn, a.conclusionEn, ...(a.items ?? []).flatMap((i: any) => [i.sectionTitleEn, i.sectionTextEn])]
      .reduce((total: number, part: any) => total + this.wordCount(part), 0);
    return Math.max(structured, this.wordCount(a.editorialEn));
  }

  private excerpt(a: any): string {
    const source = (a.introEn || a.editorialEn || '').trim();
    if (source.length <= EXCERPT_LENGTH) return source;
    const cut = source.slice(0, EXCERPT_LENGTH);
    return cut.slice(0, cut.lastIndexOf(' ')).trimEnd() + '…';
  }

  /**
   * Projection de liste : ni texte integral, ni tableau d'elements. Ce endpoint
   * est appele sur l'accueil, la page blog, chaque article et le sitemap, donc
   * il ne doit transporter que ce qu'une carte affiche.
   */
  private toListItem(a: any) {
    const primary = a.items?.[0];
    return {
      id: a.id,
      format: a.format,
      title: a.title,
      titleEn: a.titleEn,
      appleId: primary?.appleId ?? a.appleId,
      type: primary?.type ?? a.type,
      artistName: primary?.artistName ?? a.artistName,
      artworkUrl: primary?.artworkUrl ?? a.artworkUrl,
      streamCount: Number(primary?.streamCount ?? a.streamCount ?? 0) || null,
      countryCount: primary?.countryCount ?? a.countryCount ?? null,
      weekOf: a.weekOf,
      createdAt: a.createdAt,
      published: a.published,
      excerpt: this.excerpt(a),
      wordCount: this.articleWordCount(a),
      itemCount: a.items?.length ?? 1,
    };
  }

  private normalizeFormat(format?: BlogArticleFormat): BlogArticleFormat {
    if (!format) return BlogArticleFormat.SIMPLE;
    if (!Object.values(BlogArticleFormat).includes(format)) {
      throw new BadRequestException(`Format d'article inconnu : ${format}`);
    }
    return format;
  }

  private normalizeItems(items: CreateBlogArticleItemDto[]): CreateBlogArticleItemDto[] {
    return [...items]
      .sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER))
      .map((item, index) => {
        if (!item.title?.trim()) {
          throw new BadRequestException(`Titre manquant pour l'élément ${index + 1}`);
        }
        if (!item.artistName?.trim()) {
          throw new BadRequestException(`Artiste manquant pour l'élément ${index + 1}`);
        }
        if (item.type && !['songs', 'albums'].includes(item.type)) {
          throw new BadRequestException(`Type invalide pour l'élément ${index + 1}`);
        }
        return {
          ...item,
          title: item.title.trim(),
          artistName: item.artistName.trim(),
          position: index + 1,
        };
      });
  }

  private legacyItem(dto: CreateBlogArticleDto): CreateBlogArticleItemDto | null {
    const title = dto.title ?? dto.titleEn;
    if (!title || !dto.artistName) return null;
    return {
      position: 1,
      appleId: dto.appleId,
      type: dto.type,
      title,
      artistName: dto.artistName,
      artworkUrl: dto.artworkUrl,
      streamCount: dto.streamCount,
      countryCount: dto.countryCount,
    };
  }

  private buildEditorial(dto: CreateBlogArticleDto): string {
    if (dto.editorialEn?.trim()) return dto.editorialEn.trim();
    return [dto.introEn, ...(dto.items ?? []).map(item => item.sectionTextEn), dto.conclusionEn]
      .filter((part): part is string => Boolean(part?.trim()))
      .join('\n\n')
      .trim();
  }

  private itemCreateData(item: CreateBlogArticleItemDto) {
    return {
      position: item.position!,
      appleId: item.appleId ?? null,
      type: item.type ?? null,
      title: item.title,
      artistName: item.artistName,
      artworkUrl: item.artworkUrl ?? null,
      streamCount: item.streamCount ?? null,
      countryCount: item.countryCount ?? null,
      sectionTitleEn: item.sectionTitleEn ?? null,
      sectionTextEn: item.sectionTextEn ?? null,
    };
  }

  async findAll() {
    const rows = await this.prisma.blogArticle.findMany({
      where: { published: true },
      include: { items: { orderBy: { position: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(a => this.toListItem(a));
  }

  /** Article complet, servi uniquement sur sa propre page. */
  async findOne(id: number) {
    const article = await this.prisma.blogArticle.findFirst({
      where: { id, published: true },
      include: { items: { orderBy: { position: 'asc' } } },
    });
    if (!article) throw new NotFoundException(`Article ${id} introuvable`);
    return this.serialize(article);
  }

  async findAllAdmin() {
    const rows = await this.prisma.blogArticle.findMany({
      include: { items: { orderBy: { position: 'asc' } } },
      orderBy: [{ published: 'asc' }, { createdAt: 'desc' }],
    });
    return rows.map(a => this.serialize(a));
  }

  // Publie automatiquement un brouillon par jour, à 9h UTC (11h Paris l'été).
  // Les dates weekOf/createdAt sont mises au jour de publication pour que
  // le blog paraisse alimenté régulièrement.
  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async publishNext() {
    const lastPublished = await this.prisma.blogArticle.findFirst({
      where: { published: true },
      orderBy: { createdAt: 'desc' },
      select: { format: true },
    });
    const preferredFormats = Object.values(BlogArticleFormat).filter(
      format => format !== BlogArticleFormat.SIMPLE && format !== lastPublished?.format,
    );

    // Les formats éditoriaux structurés passent avant les anciens articles
    // simples, sans répéter le même format deux jours de suite.
    const draft = await this.prisma.blogArticle.findFirst({
      where: {
        published: false,
        ...(preferredFormats.length ? { format: { in: preferredFormats } } : {}),
      },
      orderBy: { id: 'asc' },
    }) ?? await this.prisma.blogArticle.findFirst({
      where: { published: false, format: { not: BlogArticleFormat.SIMPLE } },
      orderBy: { id: 'asc' },
    }) ?? await this.prisma.blogArticle.findFirst({
      where: {
        published: false,
        ...(lastPublished ? { format: { not: lastPublished.format } } : {}),
      },
      orderBy: { id: 'asc' },
    }) ?? await this.prisma.blogArticle.findFirst({
      where: { published: false },
      orderBy: { id: 'asc' },
    });
    if (!draft) return;

    const now = new Date();
    await this.prisma.blogArticle.update({
      where: { id: draft.id },
      data: { published: true, weekOf: now, createdAt: now },
    });
    this.logger.log(`Article #${draft.id} publié automatiquement : ${draft.title}`);
  }

  async create(dto: CreateBlogArticleDto) {
    const suppliedItems = dto.items?.length ? dto.items : [];
    const fallbackItem = this.legacyItem(dto);
    const items = this.normalizeItems(
      suppliedItems.length ? suppliedItems : fallbackItem ? [fallbackItem] : [],
    );
    if (!items.length) {
      throw new BadRequestException('Un article doit contenir au moins un titre ou un album');
    }

    const primary = items[0];
    const title = (dto.title ?? dto.titleEn ?? primary.title).trim();
    const titleEn = (dto.titleEn ?? dto.title ?? title).trim();
    const editorialEn = this.buildEditorial({ ...dto, items });
    if (!editorialEn) {
      throw new BadRequestException('Le texte de l’article est obligatoire');
    }

    const a = await this.prisma.blogArticle.create({
      data: {
        format: this.normalizeFormat(dto.format),
        appleId: dto.appleId ?? primary.appleId ?? null,
        type: dto.type ?? primary.type ?? null,
        title,
        titleEn,
        artistName: dto.artistName ?? primary.artistName ?? '',
        artworkUrl: dto.artworkUrl ?? primary.artworkUrl ?? null,
        streamCount: dto.streamCount ?? primary.streamCount ?? null,
        countryCount: dto.countryCount ?? primary.countryCount ?? null,
        weekOf: dto.weekOf ? new Date(dto.weekOf) : new Date(),
        editorialEn,
        introEn: dto.introEn ?? null,
        conclusionEn: dto.conclusionEn ?? null,
        published: dto.published ?? true,
        items: { create: items.map(item => this.itemCreateData(item)) },
      },
      include: { items: { orderBy: { position: 'asc' } } },
    });
    return this.serialize(a);
  }

  async update(id: number, dto: Partial<CreateBlogArticleDto>) {
    const normalizedItems = dto.items ? this.normalizeItems(dto.items) : undefined;
    if (dto.items && !normalizedItems?.length) {
      throw new BadRequestException('Un article doit contenir au moins un titre ou un album');
    }
    const primary = normalizedItems?.[0];

    const data: any = {
      ...(dto.format !== undefined && { format: this.normalizeFormat(dto.format) }),
      ...(dto.appleId !== undefined && { appleId: dto.appleId ?? null }),
      ...(dto.type !== undefined && { type: dto.type ?? null }),
      ...(dto.title !== undefined && { title: dto.title }),
      ...(dto.titleEn !== undefined && { titleEn: dto.titleEn ?? null }),
      ...(dto.artistName !== undefined && { artistName: dto.artistName }),
      ...(dto.artworkUrl !== undefined && { artworkUrl: dto.artworkUrl ?? null }),
      ...(dto.streamCount !== undefined && { streamCount: dto.streamCount ?? null }),
      ...(dto.countryCount !== undefined && { countryCount: dto.countryCount ?? null }),
      ...(dto.weekOf !== undefined && { weekOf: new Date(dto.weekOf!) }),
      ...(dto.editorialEn !== undefined && { editorialEn: dto.editorialEn }),
      ...(dto.introEn !== undefined && { introEn: dto.introEn ?? null }),
      ...(dto.conclusionEn !== undefined && { conclusionEn: dto.conclusionEn ?? null }),
      ...(dto.published !== undefined && { published: dto.published }),
    };

    if (primary) {
      data.appleId = primary.appleId ?? null;
      data.type = primary.type ?? null;
      data.artistName = primary.artistName;
      data.artworkUrl = primary.artworkUrl ?? null;
      data.streamCount = primary.streamCount ?? null;
      data.countryCount = primary.countryCount ?? null;
      data.items = {
        deleteMany: {},
        create: normalizedItems!.map(item => this.itemCreateData(item)),
      };
    }

    const a = await this.prisma.blogArticle.update({
      where: { id },
      data,
      include: { items: { orderBy: { position: 'asc' } } },
    });
    return this.serialize(a);
  }

  remove(id: number) {
    return this.prisma.blogArticle.delete({ where: { id } });
  }
}
