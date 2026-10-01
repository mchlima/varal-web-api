import { z } from 'zod';

import type { Category, Modifier, ModifierGroup, Product } from '../generated/prisma/client.js';
import { resolvePrepStationId } from '../units/routing.js';
import { ExpectedVersionSchema, NameSchema, SortOrderSchema } from '../units/units.schemas.js';

/** RN-03.09: integer cents, zero or more. */
const PriceCentsSchema = z
  .int()
  .min(0, { message: 'O preço não pode ser negativo.' })
  .max(100_000_000)
  .meta({ description: 'Preço em centavos (inteiro, maior ou igual a zero; RN-03.09).' });

const PriceDeltaCentsSchema = z
  .int()
  .min(0, { message: 'O acréscimo não pode ser negativo.' })
  .max(100_000_000)
  .meta({ description: 'Acréscimo ao preço do produto, em centavos (pode ser zero).' });

const DescriptionSchema = z
  .string()
  .trim()
  .max(120, { message: 'Use no máximo 120 caracteres.' })
  .meta({ description: 'Descrição curta, até 120 caracteres.' });

const ChoicesSchema = z.int().min(0).max(50);

// ------------------------------------------------------------------------------------------------
// Responses
// ------------------------------------------------------------------------------------------------

export const ModifierSchema = z
  .object({
    id: z.uuid(),
    modifierGroupId: z.uuid(),
    name: z.string(),
    priceDeltaCents: z.int(),
    sortOrder: z.int(),
    active: z.boolean(),
  })
  .meta({ id: 'Modifier' });

export const ModifierGroupSchema = z
  .object({
    id: z.uuid(),
    productId: z.uuid(),
    name: z.string(),
    minChoices: z.int(),
    maxChoices: z.int(),
    required: z.boolean().meta({
      description:
        'Mínimo ≥ 1: o balcão não envia o item sem escolher (RN-03.13; CA-03.06, aplicado no envio do pedido, spec 04).',
    }),
    sortOrder: z.int(),
    modifiers: z.array(ModifierSchema),
  })
  .meta({ id: 'ModifierGroup' });

export const ProductSchema = z
  .object({
    id: z.uuid(),
    unitId: z.uuid(),
    categoryId: z.uuid(),
    name: z.string(),
    description: z.string().nullable(),
    priceCents: z.int(),
    stationId: z
      .uuid()
      .nullable()
      .meta({ description: 'Estação de preparo própria; `null` usa a da categoria.' }),
    prepStationId: z.uuid().meta({
      description:
        'Estação de preparo resolvida: a do produto ou, sem ela, a da categoria (RN-03.08).',
    }),
    sortOrder: z.int(),
    active: z.boolean(),
    soldOut: z.boolean(),
    version: z.int().meta({ description: 'Versão do produto (`product.sold_out_changed`).' }),
  })
  .meta({ id: 'Product' });

export const MenuProductSchema = ProductSchema.extend({
  modifierGroups: z.array(ModifierGroupSchema),
}).meta({ id: 'MenuProduct' });

export const CategorySchema = z
  .object({
    id: z.uuid(),
    unitId: z.uuid(),
    name: z.string(),
    sortOrder: z.int(),
    defaultStationId: z.uuid().meta({ description: 'Estação de preparo padrão dos produtos.' }),
    active: z.boolean(),
  })
  .meta({ id: 'Category' });

export const MenuCategorySchema = CategorySchema.extend({
  products: z.array(MenuProductSchema),
}).meta({ id: 'MenuCategory' });

export const MenuSchema = z
  .object({
    unitId: z.uuid(),
    version: z.int().meta({ description: 'Versão do cardápio (`menu.updated`).' }),
    categories: z.array(MenuCategorySchema),
  })
  .meta({
    id: 'Menu',
    description:
      'Cardápio da unidade em ordem. O dono recebe tudo (com `active`); o colaborador só categorias, produtos e modificadores ativos (RN-03.10).',
  });

export type ModifierDto = z.infer<typeof ModifierSchema>;
export type ModifierGroupDto = z.infer<typeof ModifierGroupSchema>;
export type ProductDto = z.infer<typeof ProductSchema>;
export type CategoryDto = z.infer<typeof CategorySchema>;
export type MenuDto = z.infer<typeof MenuSchema>;

// ------------------------------------------------------------------------------------------------
// Requests
// ------------------------------------------------------------------------------------------------

export const CreateCategoryRequestSchema = z
  .object({
    unitId: z.uuid(),
    name: NameSchema,
    defaultStationId: z.uuid().optional().meta({
      description:
        'Estação de fila da unidade; sem ela, a Cozinha (ou a primeira estação de fila).',
    }),
    sortOrder: SortOrderSchema.optional(),
    active: z.boolean().optional(),
  })
  .meta({ id: 'CreateCategoryRequest' });

export const UpdateCategoryRequestSchema = z
  .object({
    name: NameSchema.optional(),
    defaultStationId: z.uuid().optional(),
    sortOrder: SortOrderSchema.optional(),
    active: z.boolean().optional(),
  })
  .meta({ id: 'UpdateCategoryRequest' });

export const CategoryOrderRequestSchema = z
  .object({
    categoryIds: z
      .array(z.uuid())
      .max(500)
      .meta({ description: 'Todas as categorias da unidade, na nova ordem.' }),
  })
  .meta({ id: 'CategoryOrderRequest' });

export const CategoryListSchema = z
  .object({ data: z.array(CategorySchema) })
  .meta({ id: 'CategoryList' });

export const CreateProductRequestSchema = z
  .object({
    categoryId: z.uuid(),
    name: NameSchema,
    description: DescriptionSchema.nullable().optional(),
    priceCents: PriceCentsSchema,
    stationId: z.uuid().nullable().optional(),
    sortOrder: SortOrderSchema.optional(),
    active: z.boolean().optional(),
  })
  .meta({ id: 'CreateProductRequest' });

export const UpdateProductRequestSchema = z
  .object({
    categoryId: z.uuid().optional().meta({ description: 'Outra categoria da mesma unidade.' }),
    name: NameSchema.optional(),
    description: DescriptionSchema.nullable().optional(),
    priceCents: PriceCentsSchema.optional(),
    stationId: z.uuid().nullable().optional(),
    sortOrder: SortOrderSchema.optional(),
    active: z.boolean().optional(),
    version: ExpectedVersionSchema.optional(),
  })
  .meta({ id: 'UpdateProductRequest' });

export const ProductOrderRequestSchema = z
  .object({
    productIds: z
      .array(z.uuid())
      .max(1000)
      .meta({ description: 'Todos os produtos da categoria, na nova ordem.' }),
  })
  .meta({ id: 'ProductOrderRequest' });

export const ProductListSchema = z
  .object({ data: z.array(ProductSchema) })
  .meta({ id: 'ProductList' });

const NewModifierSchema = z.object({
  name: NameSchema,
  priceDeltaCents: PriceDeltaCentsSchema.default(0),
  sortOrder: SortOrderSchema.optional(),
  active: z.boolean().optional(),
});

export const CreateModifierGroupRequestSchema = z
  .object({
    productId: z.uuid(),
    name: NameSchema,
    minChoices: ChoicesSchema.meta({
      description: 'Mínimo de escolhas; ≥ 1 torna o grupo obrigatório (RN-03.13).',
    }),
    maxChoices: ChoicesSchema.meta({ description: 'Máximo de escolhas, pelo menos 1.' }),
    sortOrder: SortOrderSchema.optional(),
    modifiers: z
      .array(NewModifierSchema)
      .max(50)
      .default([])
      .meta({ description: 'Opções criadas junto com o grupo.' }),
  })
  .meta({ id: 'CreateModifierGroupRequest' });

export const UpdateModifierGroupRequestSchema = z
  .object({
    name: NameSchema.optional(),
    minChoices: ChoicesSchema.optional(),
    maxChoices: ChoicesSchema.optional(),
    sortOrder: SortOrderSchema.optional(),
  })
  .meta({ id: 'UpdateModifierGroupRequest' });

export const CreateModifierRequestSchema = NewModifierSchema.extend({
  modifierGroupId: z.uuid(),
}).meta({ id: 'CreateModifierRequest' });

export const UpdateModifierRequestSchema = z
  .object({
    name: NameSchema.optional(),
    priceDeltaCents: PriceDeltaCentsSchema.optional(),
    sortOrder: SortOrderSchema.optional(),
    active: z.boolean().optional(),
  })
  .meta({ id: 'UpdateModifierRequest' });

// ------------------------------------------------------------------------------------------------
// Mapping
// ------------------------------------------------------------------------------------------------

export function toCategoryDto(category: Category): CategoryDto {
  return {
    id: category.id,
    unitId: category.unitId,
    name: category.name,
    sortOrder: category.sortOrder,
    defaultStationId: category.defaultStationId,
    active: category.active,
  };
}

export function toProductDto(product: Product, category: { defaultStationId: string }): ProductDto {
  return {
    id: product.id,
    unitId: product.unitId,
    categoryId: product.categoryId,
    name: product.name,
    description: product.description,
    priceCents: product.priceCents,
    stationId: product.stationId,
    prepStationId: resolvePrepStationId(product, category),
    sortOrder: product.sortOrder,
    active: product.active,
    soldOut: product.soldOut,
    version: product.version,
  };
}

export function toModifierDto(modifier: Modifier): ModifierDto {
  return {
    id: modifier.id,
    modifierGroupId: modifier.modifierGroupId,
    name: modifier.name,
    priceDeltaCents: modifier.priceDeltaCents,
    sortOrder: modifier.sortOrder,
    active: modifier.active,
  };
}

export function toModifierGroupDto(group: ModifierGroup, modifiers: Modifier[]): ModifierGroupDto {
  return {
    id: group.id,
    productId: group.productId,
    name: group.name,
    minChoices: group.minChoices,
    maxChoices: group.maxChoices,
    required: group.minChoices >= 1,
    sortOrder: group.sortOrder,
    modifiers: modifiers.map(toModifierDto),
  };
}
