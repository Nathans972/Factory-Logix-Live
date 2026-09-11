/** EDMX ($metadata) parsing: entity sets, entity types and property EDM types. */
import { XMLParser } from 'fast-xml-parser';
import { edmTypeToKind, type ODataEntityField, type ODataEntitySet, type ODataMetadata } from '@fld/shared';

interface XmlNode {
  [key: string]: unknown;
}

function asArray<T>(value: unknown): T[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]) as T[];
}

function attr(node: unknown, name: string): string | null {
  if (!node || typeof node !== 'object') return null;
  const v = (node as XmlNode)[`@_${name}`];
  return v === undefined || v === null ? null : String(v);
}

/** Parse an EDMX document into the shared ODataMetadata shape. */
export function parseEdmx(xml: string): ODataMetadata {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseAttributeValue: false,
    trimValues: true,
  });
  const doc = parser.parse(xml) as XmlNode;
  const edmx = (doc.Edmx ?? doc.edmx ?? {}) as XmlNode;
  const dataServices = (edmx.DataServices ?? {}) as XmlNode;

  const version = attr(dataServices, 'DataServiceVersion') ?? attr(dataServices, 'MaxDataServiceVersion') ?? attr(edmx, 'Version');

  const schemas = asArray<XmlNode>(dataServices.Schema);
  const typesByName = new Map<string, ODataEntityField[]>();
  const entitySets: ODataEntitySet[] = [];

  for (const schema of schemas) {
    const ns = attr(schema, 'Namespace') ?? '';
    for (const entityType of asArray<XmlNode>(schema.EntityType)) {
      const name = attr(entityType, 'Name');
      if (!name) continue;
      const fields: ODataEntityField[] = [];
      for (const prop of asArray<XmlNode>(entityType.Property)) {
        const pname = attr(prop, 'Name');
        if (!pname) continue;
        const edm = attr(prop, 'Type') ?? 'Edm.String';
        fields.push({
          name: pname,
          edm_type: edm,
          kind: edmTypeToKind(edm),
          nullable: (attr(prop, 'Nullable') ?? 'true') !== 'false',
        });
      }
      typesByName.set(`${ns}.${name}`, fields);
      if (!typesByName.has(name)) typesByName.set(name, fields);
    }
  }

  for (const schema of schemas) {
    for (const container of asArray<XmlNode>(schema.EntityContainer)) {
      for (const set of asArray<XmlNode>(container.EntitySet)) {
        const name = attr(set, 'Name');
        if (!name) continue;
        const typeName = attr(set, 'EntityType') ?? '';
        const bare = typeName.includes('.') ? (typeName.split('.').pop() as string) : typeName;
        const fields = typesByName.get(typeName) ?? typesByName.get(bare) ?? [];
        entitySets.push({ name, entity_type: typeName, fields });
      }
    }
  }

  return { version, entity_sets: entitySets, fetched_at: Date.now() };
}

export function findEntitySet(metadata: ODataMetadata | null, entitySet: string): ODataEntitySet | null {
  if (!metadata) return null;
  const lower = entitySet.toLowerCase();
  return metadata.entity_sets.find((s) => s.name === entitySet) ?? metadata.entity_sets.find((s) => s.name.toLowerCase() === lower) ?? null;
}

export function findField(metadata: ODataMetadata | null, entitySet: string, field: string): ODataEntityField | null {
  const set = findEntitySet(metadata, entitySet);
  if (!set) return null;
  const lower = field.toLowerCase();
  return set.fields.find((f) => f.name === field) ?? set.fields.find((f) => f.name.toLowerCase() === lower) ?? null;
}

export function edmTypeOf(metadata: ODataMetadata | null, entitySet: string, field: string): string | null {
  return findField(metadata, entitySet, field)?.edm_type ?? null;
}
