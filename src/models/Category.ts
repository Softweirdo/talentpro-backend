import { Schema, model, type Document, type Types } from 'mongoose';

export interface CategoryDoc extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  name: string;
  /** Gujarati label for the app's category dropdowns. */
  nameGu: string | null;
  slug: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const categorySchema = new Schema<CategoryDoc>(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    nameGu: { type: String, default: null, trim: true, maxlength: 60 },
    slug: { type: String, required: true, trim: true, lowercase: true },
    // Categories are archived rather than deleted — job and employee documents
    // reference them, and the counts on the admin tiles must stay meaningful.
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'categories' },
);

categorySchema.index({ slug: 1 }, { unique: true });
categorySchema.index({ isActive: 1, sortOrder: 1 });

export const Category = model<CategoryDoc>('Category', categorySchema);

export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
