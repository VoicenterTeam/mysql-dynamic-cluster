create
    definer = root@localhost procedure SP_RemoveNode(IN _ID tinyint)
BEGIN
    delete
    from `mysql-dynamic-cluster`.node
    where node_id = _ID;
end;
