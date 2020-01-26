import * as mongoose from 'mongoose';
import { IContentDocument, RefContent, IContentHasChildItems, IContentVersionDocument, IPublishedContentDocument, IContentVersion, IPublishedContent, IContent } from './content.model';
import { cmsPage } from '../page/models/page.model';
import { cmsBlock } from '../block/models/block.model';
import { cmsMedia } from '../media/models/media.model';
import { cmsPublishedPage } from '../page/models/published-page.model';
import { cmsPublishedBlock } from '../block/models/published-block.model';
import { BaseService } from '../shared/base.service';
import { cmsPublishedMedia } from '../media/models/published-media.model';

export class ContentService<T extends IContentDocument, V extends IContentVersionDocument & T, P extends IPublishedContentDocument & V> extends BaseService<T> {
    protected contentModel: mongoose.Model<T>;
    protected contentVersionModel: mongoose.Model<V>;
    protected publishedContentModel: mongoose.Model<P>;

    constructor(contentModel: mongoose.Model<T>, contentVersionModel: mongoose.Model<V>, publishedContentModel: mongoose.Model<P>) {
        super(contentModel);
        this.contentModel = contentModel;
        this.contentVersionModel = contentVersionModel;
        this.publishedContentModel = publishedContentModel;
    }

    public getPopulatedContentById = (id: string): Promise<T> => {
        if (!id) id = null;

        return this.contentModel.findOne({ _id: id })
            .populate({
                path: 'childItems.content',
                match: { isDeleted: false }
            })
            .exec();
    }

    public getPopulatedPublishedContentById = (id: string): Promise<P> => {
        if (!id) id = null;

        return this.publishedContentModel.findOne({ _id: id })
            .populate({
                path: 'publishedChildItems.content',
                match: { isDeleted: false }
            })
            .exec();
    }

    public executeCreateContentFlow = async (content: T): Promise<T> => {
        //get page's parent
        //generate url segment
        //create new page
        //update parent page's has children property
        const parentContent = await this.getModelById(content.parentId);
        const savedContent = await this.createContent(content, parentContent);
        return savedContent;
    }

    public createContent = (newContent: T, parentContent: T): Promise<T> => {
        newContent.created = new Date();
        //TODO: pageObj.createdBy = userId;
        newContent.changed = new Date();
        //TODO: pageObj.changedBy = userId;
        newContent.parentId = parentContent ? parentContent._id : null;

        //create parent path ids
        if (parentContent) {
            newContent.parentPath = parentContent.parentPath ? `${parentContent.parentPath}${parentContent._id},` : `,${parentContent._id},`;

            let ancestors = parentContent.ancestors.slice();
            ancestors.push(parentContent._id);
            newContent.ancestors = ancestors
        } else {
            newContent.parentPath = null;
            newContent.ancestors = [];
        }

        return newContent.save();
    }

    public updateHasChildren = async (content: IContentDocument): Promise<boolean> => {
        if (!content) return false;
        if (content && content.hasChildren) return true;

        content.changed = new Date();
        content.hasChildren = true;
        const savedContent = await content.save();
        return savedContent.hasChildren;
    }

    public updateAndPublishContent = async (id: string, contentObj: T): Promise<T> => {
        let currentContent = await this.getModelById(id);
        if (contentObj.isDirty) {
            currentContent = await this.updateContent(currentContent, contentObj);
        }

        if (contentObj.isPublished && (!currentContent.published || currentContent.changed > currentContent.published)) {
            currentContent = await this.executePublishContentFlow(currentContent);
        }
        return currentContent;
    }

    public executePublishContentFlow = async (currentContent: T): Promise<P> => {
        //set property isPublished = true
        const updatedContent = await this.publishContent(currentContent);
        //create page version
        const pageVersion = await this.createPageVersion(updatedContent);
        //create published content
        const publishedContent = await this.createPublishedContent(updatedContent, pageVersion._id);
        return publishedContent;
    }

    private publishContent = (currentContent: T): Promise<T> => {
        currentContent.isPublished = true;
        currentContent.published = new Date();
        //TODO: currentContent.publishedBy = userId;
        return currentContent.save()
    }

    private createPageVersion = (currentContent: T): Promise<V> => {
        const newContentVersion: IContentVersion = {
            ...currentContent.toObject(),
            contentId: currentContent._id,
            _id: new mongoose.Types.ObjectId()
        }
        const contentVersionDocument = new this.contentVersionModel(newContentVersion);
        return contentVersionDocument.save();
    }

    private createPublishedContent = async (currentContent: T, contentVersionId: string): Promise<P> => {
        //find the existing published page
        const deletedContent = await this.publishedContentModel.findOneAndDelete({ _id: currentContent._id });

        const newPublishedPage: IPublishedContent = {
            ...currentContent.toObject(),
            contentId: currentContent._id,
            contentVersionId: contentVersionId
        }

        const publishedPageDocument = new this.publishedContentModel(newPublishedPage);
        return publishedPageDocument.save();
    }

    private updateContent = (currentContent: T, pageObj: T): Promise<T> => {
        currentContent.changed = new Date();
        //TODO: currentContent.changedBy = userId
        currentContent.name = pageObj.name;
        currentContent.properties = pageObj.properties;
        currentContent.childItems = pageObj.childItems;
        currentContent.publishedChildItems = this.getPublishedChildItems(pageObj.childItems);

        return currentContent.save();
    }

    private getPublishedChildItems = (currentItems: RefContent[]): RefContent[] => {
        return currentItems.map((item: RefContent) => <RefContent>{
            content: item.content,
            refPath: this.getPublishedRefPath(item.refPath)
        })
    }

    private getPublishedRefPath = (refPath: string): string => {
        switch (refPath) {
            case cmsPage: return cmsPublishedPage;
            case cmsBlock: return cmsPublishedBlock;
            case cmsMedia: return cmsPublishedMedia;
            default: return refPath;
        }
    }

    public executeDeleteContentFlow = async (id: string): Promise<[T, any]> => {
        //find page
        const currentContent = await this.getModelById(id);
        //soft delete page
        //soft delete published page
        //soft delete page's children
        //update the 'HasChildren' field of page's parent
        const result: [T, T, any] = await Promise.all([
            this.softDeleteContent(currentContent),
            this.softDeletePublishedContent(currentContent),
            this.softDeleteContentChildren(currentContent)
        ]);

        console.log(result[2]);
        return [result[0], result[2]];
    }

    private softDeleteContent = (currentContent: T): Promise<T> => {
        currentContent.deleted = new Date();
        //TODO: currentContent.deletedBy = userId
        currentContent.isDeleted = true;
        return currentContent.save();
    }

    private softDeletePublishedContent = async (currentContent: T): Promise<T> => {
        const publishedPage = await this.publishedContentModel.findOne({ _id: currentContent._id }).exec()
        return this.softDeleteContent(publishedPage);
    }

    private softDeleteContentChildren = (currentContent: T): Promise<any> => {
        const startWithParentPathRegExp = new RegExp("^" + `${currentContent.parentPath}${currentContent._id},`);
        const conditions = { parentPath: { $regex: startWithParentPathRegExp } };
        const updateFields: Partial<IContent> = { isDeleted: true, deleted: new Date() };
        return this.contentModel.updateMany(conditions, updateFields).exec()
    }
}