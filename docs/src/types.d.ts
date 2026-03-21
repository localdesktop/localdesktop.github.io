export interface Feed {
  version: string;
  title: string;
  home_page_url: string;
  description: string;
  items: Item[];
}

export interface Item {
  id: string;
  content_html: string;
  url: string;
  title: string;
  summary: string;
  date_modified: Date;
  author: Author;
  tags: string[];
}

export interface Author {
  name: string;
  url: string;
}
